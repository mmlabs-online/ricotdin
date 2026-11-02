"""Meetings (ARC-07 part 1): reads under RLS, rename / move / pin / process.

Reads run as ``ricotdin_app`` with the caller's RLS context (owner, folder owner, editor or
viewer see a meeting; anyone else gets 404, like the v1 browser reads). Writes run as
``ricotdin_service`` after the access check in the same transaction (CLAUDE.md §0.1).
Not here yet: create + upload URL, ``uploaded``, ``audio-url`` and delete (part 2, after ARC-17);
``regenerate`` (ARC-08).
"""

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.auth.deps import current_identity
from app.core.errors import Conflict, Forbidden, NotFound
from app.db.context import RequestIdentity
from app.db.session import Database, get_database
from app.domain.access import has_role
from app.domain.rules import can_reprocess, parse_meeting_patch, parse_uuid
from app.routers._common import SERVICE, as_dict, as_dicts, json_object, path_id
from app.services.access import folder_assignable, meeting_facts

router = APIRouter(tags=["meetings"])

Identity = Annotated[RequestIdentity, Depends(current_identity)]
Db = Annotated[Database, Depends(get_database)]

MEETING_COLUMNS = (
    "id, user_id, title, status, source, storage_provider, audio_path, audio_purged_at, "
    "duration_seconds, language, summary, notes, error_message, started_at, pinned_at, "
    "folder_id, generation_provider, generation_model, created_at, updated_at"
)
_NOT_FOUND = "Meeting not found."
_NO_AUDIO = (
    "This meeting has no audio (it may have been deleted by the retention policy), "
    "so it cannot be processed."
)


@router.get("/meetings")
async def list_meetings(
    identity: Identity, db: Db, folderId: str | None = None
) -> dict[str, list[dict[str, Any]]]:
    """Every meeting the caller can see: pinned first (most recently pinned on top), then newest
    first (v1 sorted in the browser). ``folderId`` narrows to one folder."""
    sql = f"SELECT {MEETING_COLUMNS} FROM public.meetings"  # noqa: S608 - fixed column list
    params: dict[str, Any] = {}
    if folderId is not None:
        folder = parse_uuid(folderId)
        if folder is None:
            return {"meetings": []}
        sql += " WHERE folder_id = :folder"
        params["folder"] = folder
    async with db.app_transaction(identity) as conn:
        order = " ORDER BY pinned_at DESC NULLS LAST, created_at DESC"
        rows = (await conn.execute(text(sql + order), params)).all()
    return {"meetings": as_dicts(rows)}


async def _visible(conn: Any, meeting_id: uuid.UUID) -> None:
    found = await conn.execute(
        text("SELECT 1 FROM public.meetings WHERE id = :id"), {"id": meeting_id}
    )
    if found.first() is None:
        raise NotFound(_NOT_FOUND)


@router.get("/meetings/{meeting_id}")
async def get_meeting(meeting_id: str, identity: Identity, db: Db) -> dict[str, Any]:
    mid = path_id(meeting_id, _NOT_FOUND)
    async with db.app_transaction(identity) as conn:
        row = (
            await conn.execute(
                text(f"SELECT {MEETING_COLUMNS} FROM public.meetings WHERE id = :id"),  # noqa: S608
                {"id": mid},
            )
        ).first()
    meeting = as_dict(row)
    if meeting is None:
        raise NotFound(_NOT_FOUND)
    return meeting


async def _children(
    db: Database, identity: RequestIdentity, meeting_id: str, sql: str
) -> list[dict[str, Any]]:
    mid = path_id(meeting_id, _NOT_FOUND)
    async with db.app_transaction(identity) as conn:
        await _visible(conn, mid)
        rows = (await conn.execute(text(sql), {"id": mid})).all()
    return as_dicts(rows)


@router.get("/meetings/{meeting_id}/transcript")
async def get_transcript(meeting_id: str, identity: Identity, db: Db) -> dict[str, Any]:
    sql = (
        "SELECT id, meeting_id, segment_index, speaker, start_ms, end_ms, text, "
        "confidence::float8 AS confidence, "
        "created_at FROM public.transcript_segments WHERE meeting_id = :id ORDER BY segment_index"
    )
    return {"segments": await _children(db, identity, meeting_id, sql)}


@router.get("/meetings/{meeting_id}/todos")
async def get_todos(meeting_id: str, identity: Identity, db: Db) -> dict[str, Any]:
    sql = (
        "SELECT id, meeting_id, content, assignee, due_date, status, source_segment_id, "
        "created_at, updated_at FROM public.todos WHERE meeting_id = :id ORDER BY created_at"
    )
    return {"todos": await _children(db, identity, meeting_id, sql)}


@router.get("/meetings/{meeting_id}/calendar-suggestions")
async def get_calendar_suggestions(meeting_id: str, identity: Identity, db: Db) -> dict[str, Any]:
    sql = (
        "SELECT id, meeting_id, title, proposed_at, raw_mention, source_segment_id, dismissed, "
        "created_at FROM public.calendar_suggestions WHERE meeting_id = :id ORDER BY created_at"
    )
    return {"suggestions": await _children(db, identity, meeting_id, sql)}


@router.patch("/meetings/{meeting_id}")
async def update_meeting(
    meeting_id: str, request: Request, identity: Identity, db: Db
) -> dict[str, Any]:
    """Rename and/or move to a folder (editor or above; destination: owner or editor of it)."""
    changes = parse_meeting_patch(await json_object(request))
    mid = path_id(meeting_id, _NOT_FOUND)
    async with db.role_transaction(SERVICE) as conn:
        facts = await meeting_facts(conn, mid, identity.user_id, lock=True)
        if facts is None:
            raise NotFound(_NOT_FOUND)
        if not has_role(facts.role, "editor"):
            raise Forbidden("Forbidden.")
        folder = changes.get("folder_id")
        if folder is not None and not await folder_assignable(conn, folder, identity.user_id):
            raise NotFound("Folder not found.")
        sets = ", ".join(f"{k} = :{k}" for k in changes)
        await conn.execute(
            text(f"UPDATE public.meetings SET {sets} WHERE id = :id"),  # noqa: S608 - fixed keys
            {**changes, "id": mid},
        )
    out: dict[str, Any] = {"ok": True, **changes}
    if "folder_id" in out and out["folder_id"] is not None:
        out["folder_id"] = str(out["folder_id"])
    return out


@router.patch("/meetings/{meeting_id}/pin")
async def toggle_pin(meeting_id: str, identity: Identity, db: Db) -> dict[str, Any]:
    """Meeting owner only; pin state is global on the meeting."""
    mid = path_id(meeting_id, _NOT_FOUND)
    async with db.role_transaction(SERVICE) as conn:
        facts = await meeting_facts(conn, mid, identity.user_id, lock=True)
        if facts is None:
            raise NotFound(_NOT_FOUND)
        if not facts.is_meeting_owner(identity.user_id):
            raise Forbidden("Forbidden.")
        pinned = (
            await conn.execute(
                text(
                    "UPDATE public.meetings SET pinned_at = CASE WHEN pinned_at IS NULL "
                    "THEN now() END WHERE id = :id RETURNING pinned_at"
                ),
                {"id": mid},
            )
        ).scalar_one()
    return {"ok": True, "pinned_at": pinned}


@router.post("/meetings/{meeting_id}/process", status_code=202)
async def process_meeting(meeting_id: str, identity: Identity, db: Db) -> JSONResponse:
    """Meeting owner only: queue a durable job (the worker is ARC-08). 409 without audio."""
    mid = path_id(meeting_id, _NOT_FOUND)
    async with db.role_transaction(SERVICE) as conn:
        facts = await meeting_facts(conn, mid, identity.user_id)
        if facts is None:
            raise NotFound(_NOT_FOUND)
        if not facts.is_meeting_owner(identity.user_id):
            raise Forbidden("Forbidden.")
        if not can_reprocess(facts.audio_path):
            raise Conflict(_NO_AUDIO)
        await conn.execute(
            text(
                "INSERT INTO public.jobs (meeting_id, step, status, run_after, payload) "
                "VALUES (:id, 'start', 'queued', now(), '{}'::jsonb)"
            ),
            {"id": mid},
        )
    return JSONResponse(
        status_code=202, content={"ok": True, "meetingId": str(mid), "status": "processing"}
    )
