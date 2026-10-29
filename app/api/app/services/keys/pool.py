"""Provider key pools (ARC-06; port of v1 ``lib/keys/pool.ts`` and ``speechmatics-pool.ts``).

``KeyPool`` — stateless per-request rotation (Gemini, OpenAI, Grok):
- least-recently-used key among keys that are neither cooling down nor disabled;
- 429 / quota → cooldown (Retry-After if given, else ``default_cooldown_s``);
- 401 / invalid key → disabled for the life of the process;
- 403 / permission denied → 15-minute cooldown (transient, not permanent);
- 5xx / network → rotate without cooldown; 400 or ``is_non_retryable`` → raise at once;
- every key cooling down → wait for the soonest one, or fail fast past ``max_cooldown_wait_s``.

``SpeechmaticsKeyPool`` — a job keeps one key from submit to transcript; the key with the fewest
in-flight jobs is chosen.

Clock, sleep and jitter are injectable so the behaviour is tested without waiting. Plaintext keys
never appear in reprs, logs or error messages (keys are numbered ``#1..n``).
"""

import random
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Literal

import anyio

from app.core.logging import get_logger

log = get_logger("keys")

ErrorClass = Literal[
    "rate-limit", "invalid-key", "forbidden", "bad-request", "transient", "unknown"
]
FORBIDDEN_COOLDOWN_S = 15 * 60


@dataclass(frozen=True)
class KeyWithMeta:
    id: str | None  # admin_config row id; None for env-var fallback keys
    key: str = field(repr=False)


@dataclass(frozen=True)
class PoolConfig:
    default_cooldown_s: float
    base_backoff_s: float
    max_backoff_s: float
    max_attempts: int  # 0 = auto: min(2 * keys, 16)
    max_cooldown_wait_s: float


class AllKeysExhausted(Exception):
    """No key could serve the call. ``__cause__`` is the last provider error."""

    def __init__(self, pool_name: str, key_count: int, attempts: int) -> None:
        super().__init__(
            f"all {key_count} {pool_name} key(s) exhausted after {attempts} attempt(s); "
            "check key validity and quota"
        )
        self.key_count = key_count
        self.attempts = attempts


def _status(err: BaseException) -> int | None:
    for attr in ("status_code", "code", "status"):
        value = getattr(err, attr, None)
        if isinstance(value, int) and not isinstance(value, bool) and 100 <= value <= 599:
            return value
    return None


def classify_error(
    err: BaseException, is_non_retryable: Callable[[BaseException], bool]
) -> ErrorClass:
    if is_non_retryable(err):
        return "bad-request"
    status = _status(err)
    if status is not None:
        if status == 429:
            return "rate-limit"
        if status == 401:
            return "invalid-key"
        if status == 403:
            return "forbidden"
        if status == 400:
            return "bad-request"
        if status >= 500:
            return "transient"
    if isinstance(err, TimeoutError | ConnectionError):
        return "transient"
    msg = str(err)
    if re.search(r"\b429\b", msg) or re.search(r"RESOURCE_EXHAUSTED|quota", msg, re.I):
        return "rate-limit"
    if re.search(r"\b401\b", msg) or re.search(r"API_KEY_INVALID|invalid.api.key", msg, re.I):
        return "invalid-key"
    if re.search(r"\b403\b", msg) or re.search(r"permission.denied", msg, re.I):
        return "forbidden"
    if re.search(r"\b400\b", msg):
        return "bad-request"
    if re.search(r"\b(500|502|503|504)\b", msg) or re.search(
        r"UNAVAILABLE|INTERNAL|ECONNRESET|ETIMEDOUT|fetch failed|network", msg, re.I
    ):
        return "transient"
    return "unknown"


def retry_after_seconds(err: BaseException) -> float | None:
    value = getattr(err, "retry_after", None)
    if isinstance(value, int | float) and not isinstance(value, bool) and value > 0:
        return float(value)
    m = re.search(r"retry[_\-\s]?(?:after|delay)[\"':\s=]+(\d+)", str(err), re.I)
    if m and int(m.group(1)) > 0:
        return float(m.group(1))
    return None


@dataclass
class _KeyState:
    key: str = field(repr=False)
    key_id: str | None
    index: int  # 1-based, for logs
    cooldown_until: float = 0.0
    last_used_at: float = 0.0
    failures: int = 0
    disabled: bool = False


class KeyPool[C]:
    def __init__(
        self,
        keys: list[KeyWithMeta],
        build_client: Callable[[str], C],
        name: str,
        config: PoolConfig,
        *,
        is_non_retryable: Callable[[BaseException], bool] = lambda _e: False,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = anyio.sleep,
        jitter: Callable[[], float] = lambda: 0.75 + random.random() * 0.5,  # noqa: S311
    ) -> None:
        if not keys:
            raise ValueError(
                f"No {name} API keys configured: set the environment variable or add a key "
                "in the admin UI"
            )
        self._keys = [_KeyState(k.key, k.id, i + 1) for i, k in enumerate(keys)]
        self._build = build_client
        self._cfg = config
        self._name = name
        self._non_retryable = is_non_retryable
        self._clock = clock
        self._sleep = sleep
        self._jitter = jitter

    def __repr__(self) -> str:
        return f"KeyPool(name={self._name!r}, keys={len(self._keys)})"

    @property
    def size(self) -> int:
        return len(self._keys)

    @property
    def max_attempts(self) -> int:
        return self._cfg.max_attempts or min(len(self._keys) * 2, 16)

    def cooldown_until(self, index: int) -> float:
        return self._keys[index].cooldown_until

    def is_disabled(self, index: int) -> bool:
        return self._keys[index].disabled

    def _next(self) -> _KeyState | None:
        now = self._clock()
        healthy = [k for k in self._keys if not k.disabled and k.cooldown_until <= now]
        return min(healthy, key=lambda k: k.last_used_at) if healthy else None

    def _soonest(self) -> float | None:
        now = self._clock()
        cooling = [
            k.cooldown_until for k in self._keys if not k.disabled and k.cooldown_until > now
        ]
        return min(cooling) if cooling else None

    def _backoff(self, attempt: int) -> float:
        base = min(self._cfg.base_backoff_s * 2**attempt, self._cfg.max_backoff_s)
        return float(base * self._jitter())

    async def call[T](self, fn: Callable[[C, str | None], Awaitable[T]]) -> T:
        """Run ``fn(client, key_id)`` with a healthy key, rotating on retryable errors."""
        last: BaseException | None = None
        attempt = 0
        while attempt < self.max_attempts:
            state = self._next()
            if state is None:
                soonest = self._soonest()
                wait = None if soonest is None else max(0.0, soonest - self._clock()) + 0.05
                if wait is None or wait > self._cfg.max_cooldown_wait_s:
                    raise AllKeysExhausted(self._name, len(self._keys), attempt) from last
                log.warning("all %s keys cooling down; waiting %.0fs", self._name, wait)
                await self._sleep(wait)  # a pure cooldown wait does not use an attempt
                continue
            state.last_used_at = self._clock()
            try:
                result = await fn(self._build(state.key), state.key_id)
            except Exception as err:  # noqa: BLE001 - classified below, re-raised when fatal
                last = err
                kind = classify_error(err, self._non_retryable)
                if kind == "bad-request":
                    raise
                self._penalise(state, kind, err)
                if attempt < self.max_attempts - 1:
                    delay = self._backoff(attempt)
                    if delay > 0:
                        await self._sleep(delay)
                attempt += 1
                continue
            state.failures = 0
            return result
        raise AllKeysExhausted(self._name, len(self._keys), self.max_attempts) from last

    def _penalise(self, state: _KeyState, kind: ErrorClass, err: BaseException) -> None:
        state.failures += 1
        error = type(err).__name__
        if kind == "rate-limit":
            cooldown = retry_after_seconds(err) or self._cfg.default_cooldown_s
            state.cooldown_until = self._clock() + cooldown
            log.warning(
                "%s key #%d rate-limited; cooldown %.0fs", self._name, state.index, cooldown,
                extra={"error": error},
            )  # fmt: skip
        elif kind == "invalid-key":
            state.disabled = True
            log.warning("%s key #%d rejected (401): disabled until restart", self._name,
                        state.index, extra={"error": error})  # fmt: skip
        elif kind == "forbidden":
            state.cooldown_until = self._clock() + FORBIDDEN_COOLDOWN_S
            log.warning("%s key #%d forbidden (403): 15 min cooldown", self._name, state.index,
                        extra={"error": error})  # fmt: skip
        else:
            log.warning("%s key #%d transient error; rotating", self._name, state.index,
                        extra={"error": error})  # fmt: skip


@dataclass(frozen=True)
class AcquiredKey:
    api_key: str = field(repr=False)
    key_id: str | None
    key_index: int


class SpeechmaticsKeyPool:
    def __init__(self, keys: list[KeyWithMeta]) -> None:
        if not keys:
            raise ValueError(
                "No Speechmatics API keys configured: set SPEECHMATICS_API_KEY or add a key "
                "in the admin UI"
            )
        self._keys = list(keys)
        self._in_flight = [0] * len(keys)

    def __repr__(self) -> str:
        return f"SpeechmaticsKeyPool(keys={len(self._keys)})"

    @property
    def size(self) -> int:
        return len(self._keys)

    def acquire(self) -> AcquiredKey:
        index = min(range(len(self._keys)), key=lambda i: self._in_flight[i])
        self._in_flight[index] += 1
        k = self._keys[index]
        return AcquiredKey(k.key, k.id, index)

    def release(self, index: int) -> None:
        if 0 <= index < len(self._keys):
            self._in_flight[index] = max(0, self._in_flight[index] - 1)
        else:
            log.warning("speechmatics pool: release of unknown key index %d", index)

    def in_flight(self, index: int) -> int:
        return self._in_flight[index] if 0 <= index < len(self._keys) else 0
