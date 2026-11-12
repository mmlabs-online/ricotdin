"""Client activity events (ARC-07; §9g): record_start / record_stop / recording_notice_ack only,
for the caller only, at most 10 per user per minute. Best effort: a failed insert is logged and the
client still gets 200 (the event is a self-reported trail, never a gate). ``meetingId`` is kept only
for a meeting the caller can see (owner, folder owner or share), otherwise stored as NULL."""

import time
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.auth.deps import client_ip, current_identity
from app.core.errors import RateLimited
from app.core.logging import get_logger
from app.core.ratelimit import RateLimiter
from app.db.context import RequestIdentity
from app.db.session import Database, get_database
from app.domain.rules import parse_activity
from app.routers._common import SERVICE, json_object

router = APIRouter(tags=["activity"])
log = get_logger("app.activity")

MAX_PER_MINUTE = 10


def activity_limiter() -> RateLimiter:
    return RateLimiter(capacity=MAX_PER_MINUTE, refill_per_second=MAX_PER_MINUTE / 60)


@router.post("/activity")
async def record_activity(
    request: Request,
    identity: Annotated[RequestIdentity, Depends(current_identity)],
    db: Annotated[Database, Depends(get_database)],
) -> dict[str, bool]:
    event, meeting_id = parse_activity(await json_object(request), identity.user_id)
    limiter: RateLimiter = request.app.state.activity_limiter
    if not limiter.check(str(identity.user_id), now=time.monotonic()).allowed:
        raise RateLimited("Too many activity events. Slow down.")
    try:
        async with db.role_transaction(SERVICE) as conn:
            await conn.execute(
                text(
                    "INSERT INTO public.activity_log "
                    "(user_id, event_type, meeting_id, ip, user_agent) "
                    "VALUES (:u, :e, (SELECT m.id FROM public.meetings m "
                    "LEFT JOIN public.folders f ON f.id = m.folder_id "
                    "WHERE m.id = :m AND (m.user_id = :u OR f.user_id = :u OR EXISTS ("
                    "SELECT 1 FROM public.folder_shares s "
                    "WHERE s.folder_id = m.folder_id AND s.user_id = :u))), :ip, :ua)"
                ),
                {
                    "u": identity.user_id,
                    "e": event,
                    "m": meeting_id,
                    "ip": client_ip(request),
                    "ua": (request.headers.get("user-agent") or "")[:512] or None,
                },
            )
    except SQLAlchemyError as exc:
        log.warning("activity insert failed: %s", type(exc).__name__)
    return {"ok": True}
