"""A user's whole ricotdin account: export it (PRF-13 / ADM-11) or delete it (admin delete,
ARC-10a, and self-service delete, PRF-13). All SQL as ``ricotdin_service`` (CLAUDE.md §0.1);
callers do the access checks.

Delete order (CLAUDE.md §9c): the account is disabled first (no new uploads), every owned
meeting audio and the avatar are deleted from Drive, each in its own step (a failure is
reported, never fatal), then the ``users`` row goes and everything cascades (meetings, folders,
chats, quota, …; audit rows keep a NULL actor). Keys that appeared in between (an upload
confirmed just before the disable) get a second Drive pass after the row delete."""

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from fastapi import Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.ratelimit import RateLimiter
from app.db.session import Database
from app.domain.export import ExportMeeting, build_zip, export_filename, export_files
from app.domain.speakers import clean_names
from app.routers._common import SERVICE, jsonb
from app.routers.meetings import delete_files
from app.services.platform import Platform
from app.services.storage.ownership import is_owned_audio_key, is_owned_avatar_key

Step = Callable[[AsyncConnection], Awaitable[None]]
Audit = Callable[[AsyncConnection, str, dict[str, Any]], Awaitable[None]]


async def owned_keys(conn: AsyncConnection, uid: uuid.UUID) -> list[str]:
    """The user's own meeting audio keys and avatar key (a forged path is never included)."""
    meetings = (
        await conn.execute(
            text("SELECT id, user_id, audio_path FROM public.meetings WHERE user_id = :u"),
            {"u": uid},
        )
    ).all()
    keys = [
        m.audio_path for m in meetings
        if m.audio_path and is_owned_audio_key(m.audio_path, str(m.user_id), str(m.id))
    ]  # fmt: skip
    avatar = (
        await conn.execute(text("SELECT avatar_key FROM public.profiles WHERE id = :u"), {"u": uid})
    ).scalar_one_or_none()
    if avatar and is_owned_avatar_key(avatar, str(uid)):
        keys.append(avatar)
    return keys


async def _disable(conn: AsyncConnection, uid: uuid.UUID) -> None:
    await conn.execute(
        text(
            "UPDATE public.users SET disabled_at = COALESCE(disabled_at, now()), "
            "updated_at = now() WHERE id = :id"
        ),
        {"id": uid},
    )


async def delete_account(
    db: Database, platform: Platform, uid: uuid.UUID, *, check: Step, audit: Audit, action: str,
    on_disabled: Callable[[], None] = lambda: None,
) -> int:  # fmt: skip
    """Deletes the account; returns how many Drive files could not be removed. ``check`` runs at
    the start of both transactions (it may raise); ``audit`` writes ``<action>_started`` and
    ``<action>`` rows in them; ``on_disabled`` runs once the disable is committed (the caller
    drops the identity cache, so the account cannot upload during the Drive pass)."""
    async with db.role_transaction(SERVICE) as conn:
        await check(conn)
        await _disable(conn, uid)  # no new uploads while the files go
        first = await owned_keys(conn, uid)
        # committed before the irreversible Drive pass: a delete that stops half-way leaves a trace
        await audit(conn, f"{action}_started", {"files": len(first)})
    on_disabled()
    failed = await delete_files(db, platform, first)
    async with db.role_transaction(SERVICE) as conn:
        await check(conn)  # re-checked: the target may have changed
        late = [k for k in await owned_keys(conn, uid) if k not in first]
        meetings = (
            await conn.execute(
                text("SELECT count(*) FROM public.meetings WHERE user_id = :u"), {"u": uid}
            )
        ).scalar_one()
        # the audit row first: a self-delete's actor is the user, whose FK goes NULL on delete
        # (the email stays on the row)
        await audit(conn, action, {"meetings": meetings, "files": len(first) + len(late),
                                   "files_failed": len(failed)})  # fmt: skip
        # PRF-13 review: the tombstone (sha256 of the mmlabs sub = linking.sub_hash): no second
        # signup grant, and tokens from before now cannot re-create the account
        await conn.execute(
            text(
                "INSERT INTO public.deleted_accounts (sub_hash, deleted_at) "
                "SELECT encode(sha256(convert_to(mmlabs_sub, 'UTF8')), 'hex'), now() "
                "FROM public.users WHERE id = :id AND mmlabs_sub IS NOT NULL "
                "ON CONFLICT (sub_hash) DO UPDATE SET deleted_at = EXCLUDED.deleted_at"
            ),
            {"id": uid},
        )
        await conn.execute(text("DELETE FROM public.users WHERE id = :id"), {"id": uid})
    failed += await delete_files(db, platform, late)  # the map rows outlive the user
    return len(failed)


# --- export ---------------------------------------------------------------------------------------


EXPORT_CONCURRENCY = 2
_EXPORTS = asyncio.Semaphore(EXPORT_CONCURRENCY)


@dataclass(frozen=True)
class Export:
    filename: str
    data: bytes
    meetings: int


async def _rows(conn: AsyncConnection, sql: str, **args: Any) -> list[dict[str, Any]]:
    return [dict(r._mapping) for r in await conn.execute(text(sql), args)]


async def export_account(db: Database, uid: uuid.UUID, now: datetime) -> Export | None:
    """The user's own data as a ZIP (``app/domain/export.py``); ``None`` if there is no user."""
    async with db.role_transaction(SERVICE) as conn:
        profile = (
            await conn.execute(
                text(
                    "SELECT u.id, u.email, u.created_at, p.username, p.display_name, "
                    "p.default_provider, p.default_model, p.default_folder_id, p.locale, "
                    "w.audio_seconds_remaining, w.agent_queries_remaining "
                    "FROM public.users u LEFT JOIN public.profiles p ON p.id = u.id "
                    "LEFT JOIN public.quota_wallets w ON w.user_id = u.id WHERE u.id = :u"
                ),
                {"u": uid},
            )
        ).first()
        if profile is None:
            return None
        meetings = await _rows(
            conn,
            "SELECT id, title, created_at, started_at, status, duration_seconds, language, "
            "summary, notes, speaker_names FROM public.meetings WHERE user_id = :u "
            "ORDER BY created_at",
            u=uid,
        )
        ids = [m["id"] for m in meetings]
        segments = await _rows(
            conn,
            "SELECT meeting_id, speaker, start_ms, end_ms, text FROM public.transcript_segments "
            "WHERE meeting_id = ANY(CAST(:ids AS uuid[])) ORDER BY meeting_id, segment_index",
            ids=ids,
        )
        todos = await _rows(
            conn,
            "SELECT meeting_id, content, assignee, due_date, status FROM public.todos "
            "WHERE meeting_id = ANY(CAST(:ids AS uuid[])) ORDER BY meeting_id, created_at",
            ids=ids,
        )
        calendar = await _rows(
            conn,
            "SELECT meeting_id, title, proposed_at, raw_mention, dismissed "
            "FROM public.calendar_suggestions WHERE meeting_id = ANY(CAST(:ids AS uuid[])) "
            "ORDER BY meeting_id, created_at",
            ids=ids,
        )
        sessions = await _rows(
            conn,
            "SELECT id, meeting_id, folder_id, title, created_at FROM public.chat_sessions "
            "WHERE user_id = :u ORDER BY created_at",
            u=uid,
        )
        messages = await _rows(
            conn,
            "SELECT m.session_id, m.role, m.content, m.created_at FROM public.chat_messages m "
            "JOIN public.chat_sessions s ON s.id = m.session_id WHERE s.user_id = :u "
            "ORDER BY m.created_at",
            u=uid,
        )
        activity = await _rows(
            conn,
            "SELECT created_at, event_type, meeting_id, metadata, ip, user_agent "
            "FROM public.activity_log WHERE user_id = :u ORDER BY created_at",
            u=uid,
        )

    def by_meeting(rows: list[dict[str, Any]]) -> dict[Any, list[dict[str, Any]]]:
        out: dict[Any, list[dict[str, Any]]] = {}
        for r in rows:
            out.setdefault(r.pop("meeting_id"), []).append(r)
        return out

    segs, tds, cal = by_meeting(segments), by_meeting(todos), by_meeting(calendar)
    export_meetings = [
        ExportMeeting(
            id=m["id"], title=m["title"], created_at=m["created_at"],
            started_at=m["started_at"], status=m["status"],
            duration_seconds=m["duration_seconds"], language=m["language"], summary=m["summary"],
            notes=m["notes"], speaker_names=clean_names(jsonb(m["speaker_names"])),
            segments=segs.get(m["id"], []),
            todos=[{**t, "due_date": str(t["due_date"]) if t["due_date"] else None}
                   for t in tds.get(m["id"], [])],
            calendar=[{**c, "proposed_at": c["proposed_at"].isoformat() if c["proposed_at"]
                       else None} for c in cal.get(m["id"], [])],
        )
        for m in meetings
    ]  # fmt: skip
    by_session: dict[Any, list[dict[str, Any]]] = {}
    for msg in messages:
        by_session.setdefault(msg.pop("session_id"), []).append(msg)
    chats = [{**s, "messages": by_session.get(s["id"], [])} for s in sessions]
    activity_rows = [{**a, "metadata": jsonb(a["metadata"])} for a in activity]

    def build() -> bytes:
        files = export_files(profile=dict(profile._mapping), meetings=export_meetings, chats=chats,
                             activity=activity_rows, generated_at=now)  # fmt: skip
        return build_zip(files, now)

    # CPU-bound (Markdown, JSON, deflate): off the event loop, at most EXPORT_CONCURRENCY at a time
    async with _EXPORTS:
        data = await asyncio.to_thread(build)
    return Export(export_filename(profile.username, now), data, len(export_meetings))


EXPORTS_PER_HOUR = 3


def export_limiter() -> RateLimiter:
    return RateLimiter(capacity=EXPORTS_PER_HOUR, refill_per_second=EXPORTS_PER_HOUR / 3600)


def zip_response(export: Export) -> Response:
    return Response(
        content=export.data,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{export.filename}"',
            "Cache-Control": "no-store",
        },
    )
