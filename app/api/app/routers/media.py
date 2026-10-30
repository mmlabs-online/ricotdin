"""``GET /media?t=<token>`` — playback proxy for files stored in Google Drive (ARC-17).

Drive has no signed URLs, so ``<audio src>`` points here. The route is public: the short-lived
HMAC token (``media_token``) is the only authorisation and is checked before any database or
Drive call. ``Range`` is forwarded so seeking works without downloading the whole file.

Abuse limits (one user must not starve everyone's playback):
- at most ``MEDIA_STREAMS`` streams per process and ``MEDIA_STREAMS_PER_KEY`` per file (503);
- each answer carries at most ``MEDIA_WINDOW`` bytes (players ask again for the next range);
- a client that does not take a chunk within ``SEND_TIMEOUT_S`` is dropped.
The token travels in the query string, which our access log drops (strip it in proxy logs too).
The map lookup runs as ``ricotdin_worker`` (no access to users or tokens).
"""

import time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Annotated

import anyio
import httpx2
from fastapi import APIRouter, Depends, Query, Request
from starlette.responses import StreamingResponse
from starlette.types import Message, Receive, Scope, Send

from app.core.errors import Forbidden, ServiceUnavailable
from app.core.logging import get_logger
from app.db.session import Database, get_database
from app.services.platform import Platform, get_platform
from app.services.storage.base import StorageObjectNotFound
from app.services.storage.drive_rules import cap_window, content_range, parse_range

log = get_logger("media")
router = APIRouter(tags=["media"])
MEDIA_WINDOW = 4 * 1024 * 1024
SEND_TIMEOUT_S = 30.0
_CHUNK = 64 * 1024


class InvalidMediaToken(Forbidden):
    code = "invalid_media_token"
    message = "This link has expired. Please reload the page."


class MediaBusy(ServiceUnavailable):
    code = "media_busy"
    message = "Too many recordings are playing right now. Please try again shortly."


class _ProxyResponse(StreamingResponse):
    """Runs ``cleanup`` however the response ends (finished, client gone, send failed) and drops
    a client that stops reading."""

    def __init__(self, *args: object, cleanup: Callable[[], Awaitable[None]], **kw: object) -> None:
        super().__init__(*args, **kw)  # type: ignore[arg-type]
        self._cleanup = cleanup

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        async def timed_send(message: Message) -> None:
            with anyio.fail_after(SEND_TIMEOUT_S):
                await send(message)

        try:
            await super().__call__(scope, receive, timed_send)
        except TimeoutError:
            log.info("media client stopped reading; stream dropped")
        finally:
            await self._cleanup()


@router.get("/media", summary="Stream a stored file (signed, short-lived link)")
async def media(
    request: Request,
    t: Annotated[str, Query(max_length=1024)],
    platform: Annotated[Platform, Depends(get_platform)],
    db: Annotated[Database, Depends(get_database)],
) -> StreamingResponse:
    signer = platform.media_signer
    key = signer.verify(t, now=time.time()) if signer else None
    if key is None:
        raise InvalidMediaToken(detail="media token invalid or expired")
    slots = platform.media_slots
    if not slots.try_acquire(key):
        raise MediaBusy(detail=f"media stream limit reached ({slots.limit}, {slots.per_key}/file)")
    upstream: httpx2.Response | None = None
    released = False

    async def cleanup() -> None:
        nonlocal released
        if released:
            return
        released = True
        slots.release(key)
        if upstream is not None:
            await upstream.aclose()

    try:
        async with db.role_transaction("ricotdin_worker") as conn:
            storage = await platform.storage(conn)
            obj = await storage.stat(key)
        if obj is None:
            raise StorageObjectNotFound(detail="media key is not stored")
        rng = cap_window(parse_range(request.headers.get("range"), obj.size_bytes),
                         obj.size_bytes, MEDIA_WINDOW)  # fmt: skip
        upstream = await storage.client.open_media(obj.file_id, rng)
    except BaseException:
        await cleanup()
        raise

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Disposition": "inline",
        "Content-Length": str(rng.length if rng else obj.size_bytes),
        # Cache-Control stays the global no-store: meeting audio is not kept on disk
    }
    if rng:
        headers["Content-Range"] = content_range(rng, obj.size_bytes)
    body = upstream

    async def stream() -> AsyncIterator[bytes]:
        try:
            async for chunk in body.aiter_bytes(_CHUNK):  # identity: bytes as stored
                yield chunk
        except httpx2.TransportError as exc:
            # Headers are already sent: end the body short; the player re-requests the range.
            log.warning("media stream interrupted (%s)", type(exc).__name__)

    return _ProxyResponse(
        stream(),
        status_code=206 if rng else 200,
        headers=headers,
        media_type=obj.content_type,
        cleanup=cleanup,
    )
