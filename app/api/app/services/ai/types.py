"""Adapter contract and provider errors (ARC-08c; v1 ``lib/ai/types.ts``).

An adapter turns one JSON-mode request into one HTTP call to its provider and the answer into a
``Completion``. It is stateless: keys, rotation, retries and usage logging are ``AIService``'s.
Error messages carry the provider, HTTP status and a short error code — never a key, a URL query
or a response body.

Rules for a new adapter (the pool classifies by message first, then status — ``keys/pool.py``):
map "invalid / revoked key" and "out of credits" answers to a 401 (key disabled), never put
"quota" in a code unless it is a rate limit, and raise ``ModelRefused`` for refusals/safety blocks.
"""

import re
from dataclasses import dataclass
from typing import Any, Protocol

import httpx2

from app.services.ai.catalog import ProviderInfo

MAX_RESPONSE_BYTES = 8 * 1024 * 1024
_CODE = re.compile(r"[A-Za-z0-9_.-]{1,64}")


@dataclass(frozen=True)
class JsonRequest:
    model: str
    system: str
    user: str
    schema: dict[str, Any]  # neutral schema (app.services.ai.schema)
    schema_name: str


@dataclass(frozen=True)
class Completion:
    text: str
    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None


class ProviderHTTPError(Exception):
    """A non-2xx answer. ``status_code`` / ``retry_after`` drive ``KeyPool.classify_error``."""

    def __init__(
        self,
        provider: str,
        status_code: int,
        code: str | None = None,
        retry_after: float | None = None,
    ) -> None:
        self.provider = provider
        self.status_code = status_code
        self.code = code if code and _CODE.fullmatch(code) else None
        self.retry_after = retry_after
        super().__init__(f"{provider} HTTP {status_code}" + (f" {self.code}" if self.code else ""))


class ProviderTransportError(ConnectionError):
    """Network failure or timeout (transient: the pool rotates without a cooldown)."""


class ModelRefused(Exception):
    """The model declined (safety block, refusal). Not retried on another key."""


class Adapter(Protocol):
    async def complete_json(
        self, http: httpx2.AsyncClient, provider: ProviderInfo, key: str, req: JsonRequest
    ) -> Completion: ...


def token_count(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def safe_code(value: object) -> str | None:
    return value if isinstance(value, str) and _CODE.fullmatch(value) else None


def retry_after(headers: httpx2.Headers) -> float | None:
    raw = headers.get("retry-after", "").strip()
    return float(raw) if raw.isdigit() else None


async def post_json(
    http: httpx2.AsyncClient,
    provider: str,
    url: str,
    headers: dict[str, str],
    body: dict[str, Any],
    error_code: Any,
    retry_hint: Any = None,
) -> Any:
    """POST JSON, read at most ``MAX_RESPONSE_BYTES``; ``error_code(body) -> str | None`` picks a
    short code out of an error body. Raises ``ProviderHTTPError`` / ``ProviderTransportError``."""
    try:
        async with http.stream("POST", url, headers=headers, json=body) as resp:
            data = bytearray()
            async for chunk in resp.aiter_bytes():
                data += chunk
                if len(data) > MAX_RESPONSE_BYTES:
                    raise ProviderHTTPError(provider, 502, "response_too_large")
            status, hdrs = resp.status_code, resp.headers
    except httpx2.TransportError as exc:
        raise ProviderTransportError(f"{provider} {type(exc).__name__}") from None
    try:
        parsed: Any = httpx2.Response(200, content=bytes(data)).json()
    except ValueError:
        parsed = None
    if status >= 400:
        code = safe_code(error_code(parsed)) if parsed is not None else None
        wait = retry_after(hdrs)
        if wait is None and retry_hint is not None and parsed is not None:
            wait = retry_hint(parsed)
        raise ProviderHTTPError(provider, status, code, wait)
    if not isinstance(parsed, dict):
        raise ProviderHTTPError(provider, 502, "not_json")
    return parsed
