"""``GET /media?t=<token>`` — playback proxy for files stored in Google Drive (ARC-17).

Drive has no signed URLs, so ``<audio src>`` points here. The route is public: the short-lived
HMAC token (``media_token``) is the only authorisation and is checked before any database or
Drive call. ``Range`` is forwarded so seeking works without downloading the whole file. At
most ``MEDIA_STREAMS`` streams run per process (503 beyond). The token travels in the query
string, which the access log drops.
"""

import time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Annotated

import httpx2
from fastapi import APIRouter, Depends, Query, Request
from starlette.responses import StreamingResponse
from starlette.types import Receive, Scope, Send

from app.core.errors import Forbidden, ServiceUnavailable
from app.core.logging import get_logger
from app.db.session import Database, get_database
from app.services.platform import Platform, get_platform
from app.services.storage.base import StorageError, StorageObjectNotFound
from app.services.storage.drive_rules import content_range, parse_range

log = get_logger("media")
router = APIRouter(tags=["media"])
_CHUNK = 64 * 1024


class InvalidMediaToken(Forbidden):
    code = "invalid_media_token"
    message = "This link has expired. Please reload the page."


class MediaBusy(ServiceUnavailable):
    code = "media_busy"
    message = "Too many recordings are playing right now. Please try again shortly."


class _ProxyResponse(StreamingResponse):
    """Runs ``cleanup`` however the response ends (finished, client gone, send failed)."""

    def __init__(self, *args: object, cleanup: Callable[[], Awaitable[None]], **kw: object) -> None:
        super().__init__(*args, **kw)  # type: ignore[arg-type]
        self._cleanup = cleanup

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
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
    if not platform.media_slots.try_acquire():
        raise MediaBusy(detail=f"{platform.media_slots.limit} media streams already running")
    upstream: httpx2.Response | None = None
    released = False

    async def cleanup() -> None:
        nonlocal released
        if released:
            return
        released = True
        platform.media_slots.release()
        if upstream is not None:
            await upstream.aclose()

    try:
        async with db.role_transaction("ricotdin_service") as conn:
            storage = await platform.storage(conn)
            obj = await storage.stat(key)
        if obj is None:
            raise StorageObjectNotFound(detail="media key is not stored")
        rng = parse_range(request.headers.get("range"), obj.size_bytes)
        upstream = await storage.client.open_media(obj.file_id, rng)
    except BaseException:
        await cleanup()
        raise

    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=0",
        "Content-Disposition": "inline",
        "Content-Length": str(rng.length if rng else obj.size_bytes),
    }
    if rng:
        headers["Content-Range"] = content_range(rng, obj.size_bytes)
    body = upstream

    async def stream() -> AsyncIterator[bytes]:
        try:
            async for chunk in body.aiter_bytes(_CHUNK):
                yield chunk
        except httpx2.TransportError as exc:
            # Headers are already sent: the client sees a truncated body and retries the range.
            log.warning("media stream interrupted (%s)", type(exc).__name__)
            raise StorageError(detail="drive stream interrupted") from None

    return _ProxyResponse(
        stream(),
        status_code=206 if rng else 200,
        headers=headers,
        media_type=obj.content_type,
        cleanup=cleanup,
    )
