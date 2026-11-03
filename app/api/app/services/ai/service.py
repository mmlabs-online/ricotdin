"""The single entry point for generation calls (ARC-08c; v1 ``lib/ai`` + ``lib/gemini/pool``).

``AIService.generate_json`` resolves the provider/model in the catalog, picks the adapter for the
provider's ``kind``, runs the call through ONE ``KeyPool`` per provider (rebuilt only when the
active key set changes) and, when ``parse`` raises ``ParseFailed``, retries once on the SAME key
with the stricter ``retry_user`` prompt (v1). Every provider request writes a ``usage_log`` row
(``tokens``; ``ok`` / ``rate_limited`` / ``error``), best effort.

Errors out: ``AIUnavailable`` (503: no key, all keys exhausted or cooling down, network) — the
worker retries; ``AIRejected`` (422: unknown model, provider rejected the request, model refused)
and ``AIBadOutput`` (502: unusable answer twice) — terminal for the worker.
"""

import hashlib
import random
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

import anyio
import httpx2
from sqlalchemy import text

from app.core.errors import AppError, ServiceUnavailable
from app.core.logging import get_logger
from app.db.session import Database
from app.services.ai import catalog
from app.services.ai.adapters.gemini import GeminiAdapter
from app.services.ai.adapters.openai_compat import OpenAICompatAdapter
from app.services.ai.types import (
    Adapter,
    Completion,
    JsonRequest,
    ModelRefused,
    ProviderHTTPError,
)
from app.services.keys.pool import AllKeysExhausted, KeyPool, KeyWithMeta, PoolConfig
from app.services.keys.source import KeySource

log = get_logger("ai")

# provider kind → adapter. A provider with its own API (e.g. Anthropic) adds one entry here.
ADAPTERS: dict[str, Adapter] = {"gemini": GeminiAdapter(), "openai_compat": OpenAICompatAdapter()}
# v1 defaults (GEMINI_* / OPENAI_* env knobs were never set in production).
POOL_CONFIG = PoolConfig(
    default_cooldown_s=60.0, base_backoff_s=0.5, max_backoff_s=8.0, max_attempts=0,
    max_cooldown_wait_s=30.0,
)  # fmt: skip


class AIUnavailable(ServiceUnavailable):
    code = "ai_unavailable"
    message = "The AI service is not available right now. Please try again later."
    # Seconds until a cooling-down key is usable (every key was only rate-limited): the worker
    # waits that long without using an attempt.
    retry_after: float | None = None


class AIRejected(AppError):
    status = 422
    code = "ai_rejected"
    message = "The AI service could not process this meeting."


class AIBadOutput(AppError):
    status = 502
    code = "ai_bad_output"
    message = "The AI service returned an unusable answer. Please try again."


class ParseFailed(Exception):
    """Raised by a ``parse`` callback: the answer is not usable (triggers the strict retry)."""


@dataclass(frozen=True)
class UsageContext:
    meeting_id: uuid.UUID | None = None
    user_id: uuid.UUID | None = None


@dataclass
class _Call:
    status: str
    http_code: int | None
    key_id: str | None
    completion: Completion | None = None


@dataclass
class _Pool:
    fingerprint: tuple[str, ...]
    pool: KeyPool[str]


def _non_retryable(err: BaseException) -> bool:
    # Same answer on every key: never rotate (a 400 is classified as bad-request by the pool).
    if isinstance(err, ModelRefused | ParseFailed):
        return True
    return isinstance(err, ProviderHTTPError) and err.status_code in (404, 413, 422)


def _usage_status(err: BaseException) -> tuple[str, int | None]:
    if isinstance(err, ProviderHTTPError):
        return ("rate_limited" if err.status_code == 429 else "error"), err.status_code
    return "error", None


@dataclass
class AIService:
    keys: KeySource
    adapters: Mapping[str, Adapter] = field(default_factory=lambda: dict(ADAPTERS))
    transport: httpx2.AsyncBaseTransport | None = None
    sleep: Callable[[float], Awaitable[None]] = anyio.sleep
    clock: Callable[[], float] = time.monotonic
    jitter: Callable[[], float] = lambda: 0.75 + random.random() * 0.5  # noqa: S311
    pool_config: PoolConfig = POOL_CONFIG
    _pools: dict[str, _Pool] = field(default_factory=dict, repr=False)
    _http: httpx2.AsyncClient | None = field(default=None, repr=False)

    def __repr__(self) -> str:
        return "AIService()"

    @property
    def http(self) -> httpx2.AsyncClient:
        if self._http is None:
            self._http = httpx2.AsyncClient(
                transport=self.transport,
                # Long transcripts: the provider answers only when the whole JSON is written.
                timeout=httpx2.Timeout(30.0, read=300.0),
                follow_redirects=False,
            )
        return self._http

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()

    # --- keys -------------------------------------------------------------------------------------

    async def _load_keys(self, db: Database, group: str, provider: str) -> list[KeyWithMeta]:
        async with db.role_transaction(group) as conn:
            return await self.keys.active_keys(conn, provider)

    async def _pool(self, db: Database, group: str, provider: str) -> KeyPool[str]:
        keys = await self._load_keys(db, group, provider)
        fp = tuple(f"{k.id}:{hashlib.sha256(k.key.encode()).hexdigest()}" for k in keys)
        held = self._pools.get(provider)
        if held is not None and held.fingerprint == fp:
            return held.pool
        pool: KeyPool[str] = KeyPool(
            keys, lambda key: key, provider, self.pool_config,
            is_non_retryable=_non_retryable, clock=self.clock, sleep=self.sleep,
            jitter=self.jitter, on_invalid_key=self.keys.mark_invalid,
        )  # fmt: skip  # NoUsableKeys (503) without keys
        self._pools[provider] = _Pool(fp, pool)
        return pool

    # --- usage ------------------------------------------------------------------------------------

    async def _write_usage(self, db: Database, group: str, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        try:
            async with db.role_transaction(group) as conn:
                await conn.execute(
                    text(
                        "INSERT INTO usage_log (provider, model, operation, input_tokens, "
                        "output_tokens, total_tokens, unit, quantity, status, http_code, "
                        "meeting_id, user_id, key_id) VALUES (:provider, :model, :operation, "
                        ":inp, :out, :tot, 'tokens', :qty, :status, :http, :meeting, :user, "
                        "(SELECT a.id FROM admin_config a WHERE a.id = :key))"
                    ),
                    rows,
                )
        except Exception as exc:  # noqa: BLE001 - usage logging never breaks the real call (v1)
            log.warning("usage log write failed (%s)", type(exc).__name__)

    # --- generation -------------------------------------------------------------------------------

    async def generate_json[T](
        self,
        db: Database,
        group: str,
        provider: str,
        model: str,
        *,
        system: str,
        user: str,
        retry_user: str | None,
        schema: dict[str, Any],
        schema_name: str,
        operation: str,
        parse: Callable[[str], T],
        usage: UsageContext,
    ) -> T:
        try:
            info, _ = catalog.find_model(provider, model)
        except catalog.UnknownModel:
            raise AIRejected(detail=f"unknown generation model {provider}:{model}") from None
        adapter = self.adapters.get(info.kind)
        if adapter is None:
            raise AIRejected(detail=f"no adapter for provider kind {info.kind}")
        pool = await self._pool(db, group, info.name)
        calls: list[_Call] = []

        async def one(key: str, key_id: str | None, prompt: str) -> Completion:
            req = JsonRequest(model, system, prompt, schema, schema_name)
            try:
                c = await adapter.complete_json(self.http, info, key, req)
            except BaseException as exc:  # also a cancelled call: it may still be billed
                status, code = _usage_status(exc)
                calls.append(_Call(status, code, key_id))
                raise
            calls.append(_Call("ok", None, key_id, c))
            return c

        def checked(raw: str) -> T:
            try:
                return parse(raw)
            except ParseFailed:
                raise
            except Exception as exc:  # a parser bug on odd output must not rotate keys
                raise ParseFailed(f"parser error {type(exc).__name__}") from None

        async def attempt(key: str, key_id: str | None) -> T:
            first = await one(key, key_id, user)
            try:
                return checked(first.text)
            except ParseFailed:
                if retry_user is None:
                    raise
                log.warning("%s answer unusable; retrying with the strict prompt", info.name)
            return checked((await one(key, key_id, retry_user)).text)  # same key (v1)

        try:
            return await pool.call(attempt)
        except AllKeysExhausted as exc:
            unavailable = AIUnavailable(detail=str(exc))
            unavailable.retry_after = pool.ready_in()
            raise unavailable from None
        except ModelRefused as exc:
            raise AIRejected(
                "The AI model declined to process this meeting.", detail=str(exc)
            ) from None
        except ParseFailed as exc:
            raise AIBadOutput(detail=f"{info.name}:{model} {exc}"[:300]) from None
        except ProviderHTTPError as exc:  # 400 / 404 / 413 / 422: the request itself
            raise AIRejected(detail=str(exc)) from None
        finally:
            rows = [
                {"provider": info.name, "model": model, "operation": operation,
                 "inp": c.completion.input_tokens if c.completion else None,
                 "out": c.completion.output_tokens if c.completion else None,
                 "tot": c.completion.total_tokens if c.completion else None,
                 "qty": (c.completion.total_tokens or 0) if c.completion else 0,
                 "status": c.status, "http": c.http_code,
                 "meeting": usage.meeting_id, "user": usage.user_id,
                 "key": _uuid(c.key_id)}
                for c in calls
            ]  # fmt: skip
            # Shielded: a cancelled call (step timeout, shutdown, client gone) still records the
            # requests it made, bounded so shutdown is not held up.
            with anyio.CancelScope(shield=True), anyio.move_on_after(5):
                await self._write_usage(db, group, rows)


def _uuid(value: str | None) -> uuid.UUID | None:
    try:
        return uuid.UUID(value) if value else None
    except ValueError:
        return None
