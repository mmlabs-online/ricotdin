"""Helpers shared by the core-domain routers (ARC-07)."""

import json
import time
import uuid
from collections.abc import Mapping, Sequence
from typing import Any

from fastapi import Request
from sqlalchemy import Row
from sqlalchemy.exc import IntegrityError

from app.core.errors import BadRequest, NotFound, PayloadTooLarge, RateLimited
from app.core.ratelimit import RateLimiter
from app.domain.rules import parse_uuid

SERVICE = "ricotdin_service"
UNIQUE_VIOLATION = "23505"


async def json_object(
    request: Request, invalid: str = "Invalid JSON body.", *, max_bytes: int | None = None
) -> dict[str, Any]:
    """The request body as a JSON object. Bad JSON and non-objects get v1's 400 message (v1
    crashed with a 500 on ``null``, arrays and scalars). With ``max_bytes`` a larger body is
    refused (413) without reading it all."""
    if max_bytes is None:
        return json_body(await request.body(), invalid)
    declared = request.headers.get("content-length")
    if declared is not None and (not declared.isdigit() or int(declared) > max_bytes):
        raise PayloadTooLarge()
    raw = bytearray()
    async for part in request.stream():
        raw += part
        if len(raw) > max_bytes:
            raise PayloadTooLarge()
    return json_body(bytes(raw), invalid)


def json_body(raw: bytes, invalid: str = "Invalid JSON body.") -> dict[str, Any]:
    """``json_object`` for a body read earlier (to check access before parsing it)."""
    try:
        body = json.loads(raw or b"null")
    except ValueError:
        raise BadRequest(invalid) from None
    if not isinstance(body, dict):
        raise BadRequest(invalid)
    return body


def path_id(raw: str, not_found: str) -> uuid.UUID:
    """A path id; anything that is not a UUID cannot exist (v1 answered 404 too)."""
    value = parse_uuid(raw)
    if value is None:
        raise NotFound(not_found)
    return value


def as_dict(row: Row[Any] | None) -> dict[str, Any] | None:
    return None if row is None else dict(row._mapping)


def as_dicts(rows: Sequence[Row[Any]]) -> list[dict[str, Any]]:
    return [dict(r._mapping) for r in rows]


def is_unique_violation(exc: IntegrityError) -> bool:
    orig = getattr(exc, "orig", None)
    code = getattr(orig, "sqlstate", None) or getattr(orig, "pgcode", None)
    if code is None:  # asyncpg via SQLAlchemy's adapter: the driver error is one level down
        code = getattr(getattr(orig, "__cause__", None), "sqlstate", None)
    return code == UNIQUE_VIOLATION


def enforce_limit(limiter: RateLimiter, user_id: uuid.UUID, message: str | None = None) -> None:
    decision = limiter.check(str(user_id), now=time.monotonic())
    if not decision.allowed:
        raise RateLimited(message, retry_after_seconds=decision.retry_after_seconds)


def jsonb(value: Any) -> Any:
    """asyncpg returns json/jsonb as text unless a codec is set (if one is ever registered for
    jsonb, a jsonb string value would be parsed twice here: drop this then)."""
    return json.loads(value) if isinstance(value, str) else value


def pick(mapping: Mapping[str, Any], *keys: str) -> dict[str, Any]:
    return {k: mapping[k] for k in keys}
