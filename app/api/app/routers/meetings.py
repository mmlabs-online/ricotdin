"""Meetings (ARC-07): reads under RLS; create + Drive upload, uploaded, audio-url, rename / move,
pin, process (one active job per meeting), delete.

Reads run as ``ricotdin_app`` with the caller's RLS context (owner, folder owner, editor or
viewer see a meeting; anyone else gets 404, like the v1 browser reads). Writes run as
``ricotdin_service`` after the access check in the same transaction (CLAUDE.md §0.1).
Files live in Google Drive (ARC-17, CLAUDE.md §0.4): every storage call checks the key belongs to
the row first, and a Drive delete runs in its own step before the row delete. ``regenerate`` and
video audio extraction are ARC-08.
"""

import json
import time
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.auth.deps import client_ip, current_identity
from app.core.errors import Conflict, Forbidden, NotFound, RateLimited, UnprocessableEntity
from app.core.logging import get_logger
from app.core.ratelimit import RateLimiter
from app.db.context import RequestIdentity
from app.db.session import Database, get_database
from app.domain.access import can_move_meeting, has_role
from app.domain.rules import can_reprocess, parse_meeting_patch, parse_uuid
from app.domain.uploads import (
    MAX_UPLOAD_BYTES,
    audio_key,
    format_meeting_title,
    parse_meeting_create,
    parse_uploaded,
    upload_content_type,
)
from app.routers._common import (
    SERVICE,
    as_dict,
    as_dicts,
    enforce_limit,
    json_body,
    json_object,
    path_id,
)
from app.services.access import folder_assignable, meeting_facts
from app.services.ai.analysis import (
    ANALYSIS_SCHEMA,
    SegmentText,
    build_user_content,
    parse_analysis,
)
from app.services.ai.model_lock import lock_model
from app.services.ai.prompts import load_prompt
from app.services.ai.service import AIService, UsageContext
from app.services.platform import Platform, get_platform
from app.services.storage.base import StorageNotConfigured, UploadedFileMissing, UploadRejected
from app.services.storage.media_token import DEFAULT_MEDIA_TTL_S
from app.services.storage.ownership import is_owned_audio_key

router = APIRouter(tags=["meetings"])
log = get_logger("meetings")

Identity = Annotated[RequestIdentity, Depends(current_identity)]
Db = Annotated[Database, Depends(get_database)]
Plat = Annotated[Platform, Depends(get_platform)]
UPLOADS_PER_HOUR = 30
PROCESS_PER_HOUR = 30  # POST /meetings/{id}/process per user (ARC-08)
MAX_PENDING_PER_USER = 20  # unfinished uploads per user (each holds a Drive session)

MEETING_COLUMNS = (
    "id, user_id, title, status, source, storage_provider, audio_path, audio_purged_at, "
    "duration_seconds, language, summary, notes, error_message, started_at, pinned_at, "
    "folder_id, generation_provider, generation_model, created_at, updated_at"
)
_NOT_FOUND = "Meeting not found."
_STORAGE_WARNING = "Audio file could not be removed from storage."
_ALREADY_UPLOADED = "This meeting was already uploaded."
_STILL_UPLOADING = "This meeting is still being uploaded."
_MOVE_OWNER_ONLY = "Only the meeting owner can move it to another folder."
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
        if "folder_id" in changes and not can_move_meeting(
            identity.user_id, meeting_owner=facts.user_id
        ):
            raise Forbidden(_MOVE_OWNER_ONLY)
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


# One queued/running job per meeting (unique index jobs_one_active_per_meeting, migration 0005):
# a second request while one is active inserts nothing instead of failing on the index.
_QUEUE_JOB = (
    "INSERT INTO public.jobs (meeting_id, step, status, run_after, payload) "
    "VALUES (:id, 'start', 'queued', now(), CAST(:payload AS jsonb)) "
    "ON CONFLICT (meeting_id) WHERE status IN ('queued', 'running') DO NOTHING"
)


def process_limiter() -> RateLimiter:
    return RateLimiter(capacity=PROCESS_PER_HOUR, refill_per_second=PROCESS_PER_HOUR / 3600)


@router.post("/meetings/{meeting_id}/process", status_code=202)
async def process_meeting(
    meeting_id: str, request: Request, identity: Identity, db: Db
) -> JSONResponse:
    """Meeting owner only: queue a durable job, unless one is already queued or running (then
    nothing is added; still 202). 409 without audio, and while the upload is not confirmed yet
    (pending + file not mapped: ``/uploaded`` queues it). 30 calls per user per hour."""
    mid = path_id(meeting_id, _NOT_FOUND)
    enforce_limit(request.app.state.process_limiter, identity.user_id)
    async with db.role_transaction(SERVICE) as conn:
        facts = await meeting_facts(conn, mid, identity.user_id)
        if facts is None:
            raise NotFound(_NOT_FOUND)
        if not facts.is_meeting_owner(identity.user_id):
            raise Forbidden("Forbidden.")
        if not can_reprocess(facts.audio_path):
            raise Conflict(_NO_AUDIO)
        uploading = (
            await conn.execute(
                text(
                    "SELECT m.status = 'pending' AND NOT EXISTS (SELECT 1 FROM "
                    "public.storage_objects o WHERE o.key = m.audio_path) "
                    "FROM public.meetings m WHERE m.id = :id"
                ),
                {"id": mid},
            )
        ).scalar_one()
        if uploading:  # /uploaded queues the job once the file is confirmed
            raise Conflict(_STILL_UPLOADING)
        await conn.execute(text(_QUEUE_JOB), {"id": mid, "payload": "{}"})
    return JSONResponse(
        status_code=202, content={"ok": True, "meetingId": str(mid), "status": "processing"}
    )


# --- regenerate (ARC-08c; v1 POST /api/meetings/:id/regenerate) ----------------------------------

REGENERATE_PER_HOUR = 10
_BUSY = "This meeting is still being processed."
_NO_TRANSCRIPT = "No transcript available to analyze."


def regenerate_limiter() -> RateLimiter:
    return RateLimiter(capacity=REGENERATE_PER_HOUR, refill_per_second=REGENERATE_PER_HOUR / 3600)


@router.post("/meetings/{meeting_id}/regenerate")
async def regenerate_meeting(
    meeting_id: str, request: Request, identity: Identity, db: Db
) -> dict[str, Any]:
    """Meeting owner only: re-run the analysis on the stored transcript with the meeting's
    locked model and overwrite summary + notes (to-dos and calendar stay, v1). 409 while the
    meeting is pending or processing (the worker owns it); 422 without a transcript. 10 per
    user per hour. The AI call holds no database connection."""
    mid = path_id(meeting_id, _NOT_FOUND)
    enforce_limit(request.app.state.regenerate_limiter, identity.user_id)
    async with db.role_transaction(SERVICE) as conn:
        facts = await meeting_facts(conn, mid, identity.user_id)
        if facts is None:
            raise NotFound(_NOT_FOUND)
        if not facts.is_meeting_owner(identity.user_id):
            raise Forbidden("Forbidden.")
        meeting = (
            (
                await conn.execute(
                    text(
                        "SELECT id, user_id, status, started_at, generation_provider, "
                        "generation_model FROM public.meetings WHERE id = :id FOR UPDATE"
                    ),
                    {"id": mid},
                )
            )
            .mappings()
            .one()
        )
        if meeting["status"] in ("pending", "processing"):
            raise Conflict(_BUSY)
        rows = (
            await conn.execute(
                text(
                    "SELECT speaker, start_ms, text FROM public.transcript_segments "
                    "WHERE meeting_id = :id ORDER BY segment_index"
                ),
                {"id": mid},
            )
        ).all()
        if not rows:
            raise UnprocessableEntity(_NO_TRANSCRIPT)
        provider, model = await lock_model(conn, dict(meeting), {})
    segments = [SegmentText(r.speaker, r.start_ms, r.text) for r in rows]
    started = meeting["started_at"]
    meeting_date = started.isoformat() if started is not None else None
    ai: AIService = request.app.state.ai
    analysis = await ai.generate_json(
        db, SERVICE, provider, model,
        system=load_prompt(),
        user=build_user_content(segments, strict=False, meeting_date=meeting_date),
        retry_user=build_user_content(segments, strict=True, meeting_date=meeting_date),
        schema=ANALYSIS_SCHEMA, schema_name="meeting_analysis", operation="analyze",
        parse=lambda raw: parse_analysis(raw, len(segments)),
        usage=UsageContext(mid, meeting["user_id"]),
    )  # fmt: skip
    async with db.role_transaction(SERVICE) as conn:
        saved = (
            await conn.execute(
                text(
                    "UPDATE public.meetings SET summary = :s, notes = :n, status = 'done', "
                    "error_message = NULL WHERE id = :id "
                    "AND status NOT IN ('pending', 'processing') RETURNING id"
                ),
                {"id": mid, "s": analysis.summary, "n": analysis.notes},
            )
        ).first()
    if saved is None:  # reprocessed or deleted while the AI was answering
        raise Conflict(_BUSY)
    return {"ok": True, "summary": analysis.summary, "notes": analysis.notes}


# --- part 2: files (ARC-07 part 2, Google Drive) ----------------------------------------------


def upload_limiter() -> RateLimiter:
    """Drive upload sessions per user (meetings and avatars, CLAUDE.md §0.4)."""
    return RateLimiter(capacity=UPLOADS_PER_HOUR, refill_per_second=UPLOADS_PER_HOUR / 3600)


async def record_activity(
    db: Database, request: Request, user: uuid.UUID, event: str, meeting: uuid.UUID | None,
    metadata: dict[str, Any],
) -> None:  # fmt: skip
    """Best effort, like v1's fire-and-forget logActivity: a failure never breaks the request."""
    try:
        async with db.role_transaction(SERVICE) as conn:
            await conn.execute(
                text(
                    "INSERT INTO public.activity_log (user_id, event_type, meeting_id, metadata, "
                    "ip, user_agent) VALUES (:u, :e, :m, CAST(:md AS jsonb), :ip, :ua)"
                ),
                {
                    "u": user,
                    "e": event,
                    "m": meeting,
                    "md": json.dumps(metadata),
                    "ip": client_ip(request),
                    "ua": (request.headers.get("user-agent") or "")[:512] or None,
                },
            )
    except SQLAlchemyError as exc:
        log.warning("activity insert failed: %s", type(exc).__name__)


@router.post("/meetings")
async def create_meeting(request: Request, identity: Identity, db: Db, platform: Plat) -> Any:
    """Create a pending meeting and a one-time Drive upload URL for its audio. The row and the
    session are made together: if Drive fails, the row is rolled back (v1 deleted it)."""
    spec = parse_meeting_create(await json_object(request))
    enforce_limit(request.app.state.upload_limiter, identity.user_id)
    mid = uuid.uuid4()
    key = audio_key(identity.user_id, mid, spec.ext)
    started = spec.started_at or datetime.now(UTC)
    title = format_meeting_title(started)
    async with db.role_transaction(SERVICE) as conn:
        pending = (
            await conn.execute(
                text(
                    "SELECT count(*) FROM public.meetings m WHERE m.user_id = :u "
                    "AND m.status = 'pending' AND NOT EXISTS "
                    "(SELECT 1 FROM public.storage_objects o WHERE o.key = m.audio_path)"
                ),  # unfinished uploads only (an uploaded meeting waiting for the worker is fine)
                {"u": identity.user_id},
            )
        ).scalar_one()
        if pending >= MAX_PENDING_PER_USER:
            raise RateLimited(
                "Too many unfinished uploads. Finish or delete them first.",
                detail=f"{pending} pending meetings",
            )
        if spec.folder_id is not None and not await folder_assignable(
            conn, spec.folder_id, identity.user_id
        ):
            raise NotFound("Folder not found.")
        await conn.execute(
            text(
                "INSERT INTO public.meetings (id, user_id, title, status, source, "
                "storage_provider, audio_path, duration_seconds, started_at, folder_id) VALUES "
                "(:id, :u, :title, 'pending', :source, 'gdrive', :key, :dur, :started, :folder)"
            ),
            {
                "id": mid,
                "u": identity.user_id,
                "title": title,
                "source": spec.source,
                "key": key,
                "dur": spec.duration_seconds,
                "started": started,
                "folder": spec.folder_id,
            },
        )
        storage = await platform.storage(conn)
        upload_url = await storage.upload_session(
            key, spec.content_type, spec.size, max_bytes=MAX_UPLOAD_BYTES
        )
    await record_activity(
        db, request, identity.user_id, "meeting_created", mid,
        {"source": spec.source, "title": title},
    )  # fmt: skip
    # The upload URL is a bearer credential for this one file: returned once, never logged.
    return {"meetingId": str(mid), "uploadUrl": upload_url, "contentType": spec.content_type}


@router.post("/meetings/{meeting_id}/uploaded")
async def mark_uploaded(
    meeting_id: str, request: Request, identity: Identity, db: Db, platform: Plat
) -> dict[str, Any]:
    """Meeting owner only, while the meeting is still pending: verify the file the browser put in
    Drive, map it and queue processing once. Repeating the call with the same file is harmless;
    once a file is mapped, any other file answers 409 and nothing is deleted. A missing file keeps
    the meeting (422, v1); a wrong file that was this meeting's own upload is discarded together
    with the meeting (v1 ``rejectUpload``)."""
    mid = path_id(meeting_id, _NOT_FOUND)
    raw = await request.body()
    rejected: UploadRejected | None = None
    async with db.role_transaction(SERVICE) as conn:
        facts = await meeting_facts(conn, mid, identity.user_id, lock=True)
        if facts is None:
            raise NotFound(_NOT_FOUND)
        if not facts.is_meeting_owner(identity.user_id):
            raise Forbidden("Forbidden.")
        upload = parse_uploaded(json_body(raw))
        key = facts.audio_path
        content_type = upload_content_type(key) if key else None
        if (
            not key
            or content_type is None
            or not is_owned_audio_key(key, str(facts.user_id), str(mid))
        ):
            raise UnprocessableEntity("Invalid audio path for this meeting.")
        status = (
            await conn.execute(
                text("SELECT status FROM public.meetings WHERE id = :id"), {"id": mid}
            )
        ).scalar_one()
        if status != "pending":
            raise Conflict(_ALREADY_UPLOADED)
        storage = await platform.storage(conn)
        mapped = await storage.stat(key)
        if mapped is not None and mapped.file_id != upload.file_id:
            raise Conflict(_ALREADY_UPLOADED)
        try:
            await storage.confirm_upload(
                key, upload.file_id, content_type=content_type,
                content_length=upload.size, max_bytes=MAX_UPLOAD_BYTES,
            )  # fmt: skip
        except UploadedFileMissing:
            raise
        except UploadRejected as exc:
            rejected = exc
            if exc.discarded:
                await conn.execute(text("DELETE FROM public.meetings WHERE id = :id"), {"id": mid})
        if rejected is None:
            payload: dict[str, Any] = {}
            if upload.preferred:
                payload = {
                    "preferred_provider": upload.preferred[0],
                    "preferred_model": upload.preferred[1],
                }
            await conn.execute(text(_QUEUE_JOB), {"id": mid, "payload": json.dumps(payload)})
    if rejected is not None:
        raise rejected
    return {"ok": True, "meetingId": str(mid)}


@router.get("/meetings/{meeting_id}/audio-url")
async def audio_url(meeting_id: str, identity: Identity, db: Db, platform: Plat) -> dict[str, Any]:
    """A short-lived ``/media`` playback link (viewer or above) plus the audio-render flag."""
    mid = path_id(meeting_id, _NOT_FOUND)
    async with db.role_transaction(SERVICE) as conn:
        facts = await meeting_facts(conn, mid, identity.user_id)
        if facts is None:
            raise NotFound(_NOT_FOUND)
        if not has_role(facts.role, "viewer"):
            raise Forbidden("Forbidden.")
        key = facts.audio_path
        if not key or not is_owned_audio_key(key, str(facts.user_id), str(mid)):
            if key:
                log.warning("meeting audio_path is not its own key; not signing")
            raise NotFound("No audio for this meeting.")
        hack = await platform.config.flag(conn, "user_hack_audio_render", False)
    signer = platform.media_signer
    if signer is None:
        raise StorageNotConfigured(detail="KEY_ENCRYPTION_SECRET is not set: no media links")
    token = signer.sign(key, now=time.time(), ttl=DEFAULT_MEDIA_TTL_S)
    return {"url": f"/media?t={token}", "hackAudioRender": hack}


async def delete_files(db: Database, platform: Platform, keys: list[str]) -> list[str]:
    """Delete owned keys from Drive, each in its own committed step (CLAUDE.md §0.4: never inside
    a transaction that may roll back the map). Returns the keys that failed. Never raises."""
    failed: list[str] = []
    for key in keys:
        try:
            async with db.role_transaction(SERVICE) as conn:
                storage = await platform.storage(conn)
                await storage.delete(key)
        except Exception as exc:  # noqa: BLE001 - reported as a warning, the row delete goes on
            log.warning("audio delete failed (%s)", type(exc).__name__)
            failed.append(key)
    return failed


@router.delete("/meetings/{meeting_id}")
async def delete_meeting(
    meeting_id: str, request: Request, identity: Identity, db: Db, platform: Plat
) -> dict[str, Any]:
    """Meeting owner only. Audio first (CLAUDE.md §6): a storage failure adds ``warning`` but
    the row is still deleted; child rows cascade."""
    mid = path_id(meeting_id, _NOT_FOUND)
    async with db.role_transaction(SERVICE) as conn:
        facts = await meeting_facts(conn, mid, identity.user_id)
    if facts is None:
        raise NotFound(_NOT_FOUND)
    if not facts.is_meeting_owner(identity.user_id):
        raise Forbidden("Forbidden.")
    warning = None
    key = facts.audio_path
    if key and not is_owned_audio_key(key, str(facts.user_id), str(mid)):
        log.warning("meeting audio_path is not its own key; not deleting it")
    elif key and await delete_files(db, platform, [key]):
        warning = _STORAGE_WARNING
    async with db.role_transaction(SERVICE) as conn:
        await conn.execute(
            text("DELETE FROM public.meetings WHERE id = :id AND user_id = :u"),
            {"id": mid, "u": identity.user_id},
        )
    if key and warning is None and is_owned_audio_key(key, str(facts.user_id), str(mid)):
        # An upload confirmed between the storage delete and the row delete would be left
        # behind; /uploaded cannot map it any more once the row is gone, so one more pass is
        # enough (a no-op when nothing is mapped).
        await delete_files(db, platform, [key])
    # meeting_id stays NULL: the row is gone (BUG-012); the id goes in metadata.
    await record_activity(
        db, request, identity.user_id, "meeting_deleted", None, {"meeting_id": str(mid)}
    )
    out: dict[str, Any] = {"ok": True}
    if warning:
        out["warning"] = warning
    return out
