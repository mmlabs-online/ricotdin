"""ARC-06: provider key pools (port of legacy/tests/key-pool-base.test.ts and
key-pool-speechmatics.test.ts). Pure: clock, sleep and jitter are injected, nothing waits."""

from collections.abc import Awaitable, Callable
from typing import Any

import anyio
import pytest

from app.services.keys.pool import (
    AllKeysExhausted,
    KeyPool,
    KeyWithMeta,
    NoUsableKeys,
    PoolConfig,
    SpeechmaticsKeyPool,
    classify_error,
    retry_after_seconds,
)

CFG = PoolConfig(
    default_cooldown_s=60,
    base_backoff_s=0.5,
    max_backoff_s=8,
    max_attempts=0,
    max_cooldown_wait_s=30,
)


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


class HttpError(Exception):
    def __init__(self, code: int, message: str = "") -> None:
        super().__init__(message or f"HTTP {code}")
        self.code = code


def _keys(n: int) -> list[KeyWithMeta]:
    return [KeyWithMeta(id=f"id{i}" if i % 2 == 0 else None, key=f"k{i}") for i in range(n)]


def _pool(n: int = 3, cfg: PoolConfig = CFG, **kw: Any) -> tuple[KeyPool[str], FakeClock]:
    clock = FakeClock()
    pool: KeyPool[str] = KeyPool(
        _keys(n), lambda k: f"client:{k}", "test", cfg, clock=clock, sleep=clock.sleep,
        jitter=lambda: 1.0, **kw,
    )  # fmt: skip
    return pool, clock


def _run[T](fn: Callable[[], Awaitable[T]]) -> T:
    return anyio.run(fn)


# --- construction -------------------------------------------------------------------------------


def test_empty_key_list_is_refused() -> None:
    with pytest.raises(NoUsableKeys, match="No usable test API keys"):
        KeyPool([], lambda k: k, "test", CFG)


def test_single_key_is_accepted() -> None:
    pool, _ = _pool(1)
    assert pool.size == 1


def test_repr_never_contains_keys() -> None:
    pool, _ = _pool(2)
    assert "k0" not in repr(pool) and "k1" not in repr(pool)
    assert "k0" not in repr(KeyWithMeta(id=None, key="k0"))


# --- success / LRU ------------------------------------------------------------------------------


def test_returns_result_and_threads_key_id() -> None:
    pool, _ = _pool(1)

    async def go() -> tuple[str, str | None]:
        return await pool.call(lambda client, key_id: _const((client, key_id)))

    assert _run(go) == ("client:k0", "id0")


def test_env_keys_thread_none_as_id() -> None:
    clock = FakeClock()
    pool: KeyPool[str] = KeyPool([KeyWithMeta(None, "env")], lambda k: k, "t", CFG, clock=clock)

    async def go() -> str | None:
        return await pool.call(lambda _c, key_id: _const(key_id))

    assert _run(go) is None


async def _const[T](value: T) -> T:
    return value


def test_least_recently_used_rotation() -> None:
    pool, clock = _pool(3)
    used: list[str] = []

    async def go() -> None:
        for _ in range(6):
            clock.now += 1
            used.append(await pool.call(lambda c, _id: _const(c)))

    _run(go)
    assert used == ["client:k0", "client:k1", "client:k2"] * 2


# --- error handling -----------------------------------------------------------------------------


def _failing(
    errors: list[BaseException | None], used: list[str]
) -> Callable[[str, str | None], Awaitable[str]]:
    async def fn(client: str, _id: str | None) -> str:
        used.append(client)
        err = errors.pop(0) if errors else None
        if err is not None:
            raise err
        return "ok"

    return fn


def test_429_rotates_and_cools_the_key_down() -> None:
    pool, clock = _pool(2)
    used: list[str] = []

    async def go() -> str:
        return await pool.call(_failing([HttpError(429)], used))

    assert _run(go) == "ok"
    assert used == ["client:k0", "client:k1"]
    assert pool.cooldown_until(0) == pytest.approx(
        clock.now - CFG.base_backoff_s + CFG.default_cooldown_s
    )


def test_retry_after_from_the_error_is_used() -> None:
    assert retry_after_seconds(Exception("429 RESOURCE_EXHAUSTED retryDelay: 17s")) == 17
    assert retry_after_seconds(Exception("Retry-After: 5")) == 5
    assert retry_after_seconds(Exception("nothing here")) is None

    class WithHeader(Exception):
        retry_after = 9.0

    assert retry_after_seconds(WithHeader("429")) == 9.0


def test_single_rate_limited_key_fails_fast_when_cooldown_exceeds_wait() -> None:
    pool, _ = _pool(1)

    async def go() -> str:
        return await pool.call(_failing([HttpError(429)] * 5, []))

    with pytest.raises(AllKeysExhausted) as exc:
        _run(go)
    assert exc.value.key_count == 1
    assert exc.value.last_status == 429


def test_short_cooldown_is_waited_out() -> None:
    cfg = PoolConfig(
        default_cooldown_s=5,
        base_backoff_s=0,
        max_backoff_s=0,
        max_attempts=4,
        max_cooldown_wait_s=30,
    )
    pool, clock = _pool(1, cfg)
    used: list[str] = []

    async def go() -> str:
        return await pool.call(_failing([HttpError(429)], used))

    assert _run(go) == "ok"
    assert used == ["client:k0", "client:k0"]
    assert any(s >= 5 for s in clock.slept)


def test_401_disables_the_key_permanently() -> None:
    pool, clock = _pool(2)
    used: list[str] = []

    async def go() -> None:
        await pool.call(_failing([HttpError(401)], used))
        clock.now += 10_000
        await pool.call(_failing([], used))
        await pool.call(_failing([], used))

    _run(go)
    assert used == ["client:k0", "client:k1", "client:k1", "client:k1"]
    assert pool.is_disabled(0)


def test_single_key_401_exhausts() -> None:
    pool, _ = _pool(1)

    async def go() -> str:
        return await pool.call(_failing([HttpError(401)], []))

    with pytest.raises(AllKeysExhausted):
        _run(go)


def test_403_is_a_fifteen_minute_cooldown_not_a_disable() -> None:
    pool, clock = _pool(2)

    async def go() -> str:
        return await pool.call(_failing([HttpError(403)], []))

    _run(go)
    assert not pool.is_disabled(0)
    assert pool.cooldown_until(0) >= clock.now + 15 * 60 - 1


def test_non_retryable_errors_surface_immediately() -> None:
    class Bad(Exception):
        pass

    pool, _ = _pool(3, is_non_retryable=lambda e: isinstance(e, Bad))
    used: list[str] = []

    async def go() -> str:
        return await pool.call(_failing([Bad("schema")], used))

    with pytest.raises(Bad):
        _run(go)
    assert used == ["client:k0"]


def test_400_surfaces_immediately() -> None:
    pool, _ = _pool(3)
    used: list[str] = []

    async def go() -> str:
        return await pool.call(_failing([HttpError(400)], used))

    with pytest.raises(HttpError):
        _run(go)
    assert len(used) == 1


def test_transient_errors_rotate_without_cooldown() -> None:
    pool, _ = _pool(2)
    used: list[str] = []

    async def go() -> str:
        return await pool.call(_failing([ConnectionResetError("ECONNRESET")], used))

    assert _run(go) == "ok"
    assert used == ["client:k0", "client:k1"]
    assert pool.cooldown_until(0) == 0


def test_max_attempts_and_exhaustion_details() -> None:
    cfg = PoolConfig(
        default_cooldown_s=60,
        base_backoff_s=0,
        max_backoff_s=0,
        max_attempts=3,
        max_cooldown_wait_s=30,
    )
    pool, _ = _pool(5, cfg)
    used: list[str] = []

    async def go() -> str:
        return await pool.call(_failing([HttpError(503)] * 10, used))

    with pytest.raises(AllKeysExhausted) as exc:
        _run(go)
    assert len(used) == 3
    assert (exc.value.key_count, exc.value.attempts) == (5, 3)
    assert "k0" not in str(exc.value)  # never the key itself


def test_auto_max_attempts_is_twice_the_keys_capped_at_16() -> None:
    for n, expected in [(1, 2), (3, 6), (8, 16), (20, 16)]:
        pool, _ = _pool(n)
        assert pool.max_attempts == expected


def test_backoff_grows_and_is_capped() -> None:
    pool, clock = _pool(10)

    async def go() -> str:
        return await pool.call(_failing([HttpError(503)] * 6, []))

    _run(go)
    assert clock.slept == [0.5, 1.0, 2.0, 4.0, 8.0, 8.0]


@pytest.mark.parametrize(
    ("err", "kind"),
    [
        (HttpError(429), "rate-limit"),
        (Exception("RESOURCE_EXHAUSTED: quota exceeded"), "rate-limit"),
        (HttpError(401), "invalid-key"),
        (Exception("API_KEY_INVALID"), "invalid-key"),
        (HttpError(403), "forbidden"),
        (Exception("PERMISSION_DENIED"), "forbidden"),
        (HttpError(400), "bad-request"),
        (HttpError(500), "transient"),
        (HttpError(503), "transient"),
        (TimeoutError(), "transient"),
        (ConnectionError("reset"), "transient"),
        (Exception("UNAVAILABLE"), "transient"),
        (Exception("weird"), "unknown"),
    ],
)
def test_error_classification(err: Exception, kind: str) -> None:
    assert classify_error(err, lambda _e: False) == kind


def test_status_code_attribute_wins_over_message() -> None:
    class Resp(Exception):
        status_code = 401

    assert classify_error(Resp("429 in the text"), lambda _e: False) == "invalid-key"


# --- Speechmatics (least in-flight jobs) --------------------------------------------------------


def test_speechmatics_needs_keys() -> None:
    with pytest.raises(NoUsableKeys, match="Speechmatics"):
        SpeechmaticsKeyPool([])


def test_speechmatics_single_key() -> None:
    pool = SpeechmaticsKeyPool([KeyWithMeta("a", "k")])
    got = pool.acquire()
    assert (got.api_key, got.key_id, got.key_index) == ("k", "a", 0)
    assert pool.in_flight(0) == 1
    pool.release(0)
    pool.release(0)
    assert pool.in_flight(0) == 0
    pool.release(5)  # out of range: no-op
    pool.release(-1)


def test_speechmatics_least_active_and_tie_order() -> None:
    pool = SpeechmaticsKeyPool(_keys(3))
    order = [pool.acquire().key_index for _ in range(6)]
    assert order == [0, 1, 2, 0, 1, 2]
    pool.release(1)
    pool.release(1)
    assert pool.acquire().key_index == 1


def test_speechmatics_repr_hides_keys() -> None:
    assert "k0" not in repr(SpeechmaticsKeyPool(_keys(1)))


# --- review round 1 --------------------------------------------------------------------------


class GenaiClientError(Exception):
    """Shaped like google.genai.errors.ClientError (code + message)."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(f"{code} {message}")
        self.code = code


class OpenAIStatusError(Exception):
    """Shaped like openai.APIStatusError (status_code + response.headers)."""

    def __init__(self, status_code: int, headers: dict[str, str]) -> None:
        super().__init__(f"Error code: {status_code}")
        self.status_code = status_code
        self.response = type("Resp", (), {"headers": headers})()


def test_gemini_invalid_key_400_is_an_invalid_key_not_a_bad_request() -> None:
    err = GenaiClientError(
        400, "INVALID_ARGUMENT. API key not valid. Please pass a valid API key. API_KEY_INVALID"
    )
    assert classify_error(err, lambda _e: False) == "invalid-key"
    pool, _ = _pool(2)
    used: list[str] = []

    async def go() -> str:
        return await pool.call(_failing([err], used))

    assert _run(go) == "ok" and used == ["client:k0", "client:k1"] and pool.is_disabled(0)


def test_quota_message_is_a_rate_limit_whatever_the_status() -> None:
    err = GenaiClientError(400, "RESOURCE_EXHAUSTED quota")
    assert classify_error(err, lambda _e: False) == "rate-limit"


def test_plain_400_is_still_a_bad_request() -> None:
    err = GenaiClientError(400, "INVALID_ARGUMENT: bad schema")
    assert classify_error(err, lambda _e: False) == "bad-request"


def test_retry_after_header_of_http_sdks_is_used_and_capped() -> None:
    assert retry_after_seconds(OpenAIStatusError(429, {"retry-after": "12"})) == 12
    assert retry_after_seconds(OpenAIStatusError(429, {"Retry-After": "999999"})) == 3600
    assert retry_after_seconds(OpenAIStatusError(429, {"retry-after": "soon"})) is None


def test_a_cooldown_wait_does_not_use_an_attempt() -> None:
    cfg = PoolConfig(
        default_cooldown_s=5, base_backoff_s=0, max_backoff_s=0, max_attempts=2,
        max_cooldown_wait_s=30,
    )  # fmt: skip
    pool, _ = _pool(1, cfg)
    used: list[str] = []

    async def go() -> str:
        return await pool.call(_failing([HttpError(429)], used))

    assert _run(go) == "ok" and len(used) == 2


def test_exhaustion_does_not_chain_the_provider_error_but_keeps_safe_facts() -> None:
    pool, _ = _pool(1)

    async def go() -> str:
        errors: list[BaseException | None] = [GenaiClientError(503, "UNAVAILABLE key=sm_x_123")] * 3
        return await pool.call(_failing(errors, []))

    with pytest.raises(AllKeysExhausted) as exc:
        _run(go)
    assert exc.value.__cause__ is None and exc.value.__suppress_context__
    assert (exc.value.last_error_type, exc.value.last_status) == ("GenaiClientError", 503)
    assert "sm_x_123" not in str(exc.value)


def test_a_client_factory_bug_is_not_retried_on_every_key() -> None:
    def broken(_key: str) -> str:
        raise RuntimeError("bug in factory")

    clock = FakeClock()
    pool: KeyPool[str] = KeyPool(_keys(3), broken, "t", CFG, clock=clock, sleep=clock.sleep)

    async def go() -> str:
        return await pool.call(lambda c, _i: _const(c))

    with pytest.raises(RuntimeError, match="factory"):
        _run(go)


def test_invalid_keys_are_reported_so_later_pools_skip_them() -> None:
    reported: list[str] = []
    clock = FakeClock()
    pool: KeyPool[str] = KeyPool(
        _keys(2), lambda k: k, "t", CFG, clock=clock, sleep=clock.sleep, jitter=lambda: 1.0,
        on_invalid_key=lambda k: reported.append(k.key),
    )  # fmt: skip

    async def go() -> str:
        return await pool.call(_failing([HttpError(401)], []))

    _run(go)
    assert reported == ["k0"]
