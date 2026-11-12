"""Editing a meeting's summary / notes and their version history (PRO-06).

Writes (edit, restore) need editor or above and run as ``ricotdin_service`` after the access check
in the same transaction, like every meeting write (CLAUDE.md §0.6). The history is read as
``ricotdin_app`` under RLS (anyone who can view the meeting). A save carries the sha-256 of the
text it started from; a different current text answers 409 instead of overwriting someone else's
change."""

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy import text

from app.auth.deps import current_identity
from app.core.errors import Conflict, Forbidden, NotFound
from app.core.ratelimit import RateLimiter
from app.db.context import RequestIdentity
from app.db.session import Database, get_database
from app.domain.access import has_role
from app.domain.content import (
    ContentField,
    VersionSource,
    content_hash,
    parse_content_edit,
    parse_content_field,
    parse_restore,
)
from app.routers._common import SERVICE, as_dicts, enforce_limit, json_object, path_id
from app.services.access import meeting_facts
from app.services.note_versions import record_versions

router = APIRouter(tags=["meetings"])
Identity = Annotated[RequestIdentity, Depends(current_identity)]
Db = Annotated[Database, Depends(get_database)]

EDITS_PER_HOUR = 120
MAX_EDIT_BODY = 2_500_000  # 200 000 characters, JSON-escaped
_NOT_FOUND = "Meeting not found."
_VERSION_NOT_FOUND = "Version not found."
_NOT_DONE = "This meeting has no finished summary and notes to edit yet."


class ContentChanged(Conflict):
    code = "content_changed"


def content_limiter() -> RateLimiter:
    return RateLimiter(capacity=EDITS_PER_HOUR, refill_per_second=EDITS_PER_HOUR / 3600)


async def _save(
    db: Database,
    identity: RequestIdentity,
    mid: uuid.UUID,
    field: ContentField,
    base_hash: str,
    *,
    content: str | None = None,
    version_id: uuid.UUID | None = None,
) -> dict[str, Any]:
    source: VersionSource = "user" if version_id is None else "restore"
    async with db.role_transaction(SERVICE) as conn:
        facts = await meeting_facts(conn, mid, identity.user_id, lock=True)
        if facts is None:
            raise NotFound(_NOT_FOUND)
        if not has_role(facts.role, "editor"):
            raise Forbidden("Forbidden.")
        row = (
            await conn.execute(
                text("SELECT status, summary, notes FROM public.meetings WHERE id = :id"),
                {"id": mid},
            )
        ).one()
        if row.status != "done":
            raise Conflict(_NOT_DONE)
        current: str | None = row.summary if field == "summary" else row.notes
        if content_hash(current) != base_hash:
            raise ContentChanged("The text was changed in the meantime. Reload it and try again.")
        if version_id is not None:
            content = (
                await conn.execute(
                    text(
                        "SELECT content FROM public.meeting_note_versions "
                        "WHERE id = :v AND meeting_id = :m AND field = :f"
                    ),
                    {"v": version_id, "m": mid, "f": field},
                )
            ).scalar_one_or_none()
            if content is None:
                raise NotFound(_VERSION_NOT_FOUND)
        if content is None:  # neither a text nor a version: a caller bug
            raise NotFound(_VERSION_NOT_FOUND)
        if content == (current or ""):  # nothing changed: no write, no duplicate version
            return {"field": field, "content": content, "contentHash": content_hash(content)}
        column = "summary" if field == "summary" else "notes"  # fixed column names only
        await conn.execute(
            text(f"UPDATE public.meetings SET {column} = :c WHERE id = :id"),  # noqa: S608
            {"c": content, "id": mid},
        )
        await record_versions(
            conn, mid, field, current=current, new=content, source=source, editor=identity.user_id
        )
    return {"field": field, "content": content, "contentHash": content_hash(content)}


@router.patch("/meetings/{meeting_id}/content")
async def edit_content(
    meeting_id: str, request: Request, identity: Identity, db: Db
) -> dict[str, Any]:
    """Save the summary or the notes (editor or above, finished meetings only)."""
    enforce_limit(request.app.state.content_limiter, identity.user_id)
    # 200 000 characters, JSON-escaped, stay under this (review round 1: body cap)
    edit = parse_content_edit(await json_object(request, max_bytes=MAX_EDIT_BODY))
    mid = path_id(meeting_id, _NOT_FOUND)
    return await _save(db, identity, mid, edit.field, edit.base_hash, content=edit.content)


@router.post("/meetings/{meeting_id}/content-versions/{version_id}/restore")
async def restore_version(
    meeting_id: str, version_id: str, request: Request, identity: Identity, db: Db
) -> dict[str, Any]:
    """Make an earlier version current again; it becomes a new version (editor or above)."""
    enforce_limit(request.app.state.content_limiter, identity.user_id)
    base_hash = parse_restore(await json_object(request, max_bytes=4096))
    mid = path_id(meeting_id, _NOT_FOUND)
    vid = path_id(version_id, _VERSION_NOT_FOUND)
    async with db.app_transaction(identity) as conn:  # which field, under RLS
        field = (
            await conn.execute(
                text(
                    "SELECT field FROM public.meeting_note_versions "
                    "WHERE id = :v AND meeting_id = :m"
                ),
                {"v": vid, "m": mid},
            )
        ).scalar_one_or_none()
    if field is None:
        raise NotFound(_VERSION_NOT_FOUND)
    return await _save(db, identity, mid, parse_content_field(field), base_hash, version_id=vid)


@router.get("/meetings/{meeting_id}/content-versions")
async def list_versions(meeting_id: str, field: str, identity: Identity, db: Db) -> dict[str, Any]:
    """Newest first, without the text (viewer or above)."""
    name = parse_content_field(field)
    mid = path_id(meeting_id, _NOT_FOUND)
    async with db.app_transaction(identity) as conn:
        visible = (
            await conn.execute(text("SELECT 1 FROM public.meetings WHERE id = :id"), {"id": mid})
        ).first()
        if visible is None:
            raise NotFound(_NOT_FOUND)
        rows = as_dicts(
            (
                await conn.execute(
                    text(
                        "SELECT id, field, source, edited_by, created_at, "
                        "char_length(content) AS length FROM public.meeting_note_versions "
                        "WHERE meeting_id = :m AND field = :f ORDER BY created_at DESC, id DESC"
                    ),
                    {"m": mid, "f": name},
                )
            ).all()
        )
    editors = sorted({r["edited_by"] for r in rows if r["edited_by"] is not None}, key=str)
    names: dict[uuid.UUID, str | None] = {}
    if editors:  # usernames of the editors: profiles of other users are not app-readable
        async with db.role_transaction(SERVICE) as conn:
            for r in await conn.execute(
                text("SELECT id, username FROM public.profiles WHERE id = ANY(:ids)"),
                {"ids": editors},
            ):
                names[r.id] = r.username
    return {
        "versions": [
            {
                "id": str(r["id"]),
                "field": r["field"],
                "source": r["source"],
                "editedBy": str(r["edited_by"]) if r["edited_by"] else None,
                "editedByUsername": names.get(r["edited_by"]) if r["edited_by"] else None,
                "createdAt": r["created_at"].isoformat(),
                "length": r["length"],
            }
            for r in rows
        ]
    }


@router.get("/meetings/{meeting_id}/content-versions/{version_id}")
async def get_version(
    meeting_id: str, version_id: str, identity: Identity, db: Db
) -> dict[str, Any]:
    mid = path_id(meeting_id, _NOT_FOUND)
    vid = path_id(version_id, _VERSION_NOT_FOUND)
    async with db.app_transaction(identity) as conn:
        row = (
            await conn.execute(
                text(
                    "SELECT id, field, source, edited_by, created_at, content "
                    "FROM public.meeting_note_versions WHERE id = :v AND meeting_id = :m"
                ),
                {"v": vid, "m": mid},
            )
        ).first()
    if row is None:
        raise NotFound(_VERSION_NOT_FOUND)
    return {
        "id": str(row.id),
        "field": row.field,
        "source": row.source,
        "editedBy": str(row.edited_by) if row.edited_by else None,
        "createdAt": row.created_at.isoformat(),
        "content": row.content,
        "contentHash": content_hash(row.content),
    }
