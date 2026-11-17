"""Speaker names (PRO-04): ``PATCH /meetings/{id}/speakers`` (owner or editor, written as
``ricotdin_service`` after the access check, CLAUDE.md §0.1) and ``GET /speakers/suggestions``
(names in meetings the caller can see, as ``ricotdin_app`` under RLS). Pure parts:
``app/domain/speakers.py``."""

import json
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy import text

from app.auth.deps import current_identity
from app.core.errors import Forbidden, NotFound
from app.db.context import RequestIdentity
from app.db.session import Database, get_database
from app.domain.access import has_role
from app.domain.speakers import clean_names, merge_names, parse_speaker_patch, rank_suggestions
from app.routers._common import SERVICE, enforce_limit, json_object, jsonb, path_id
from app.services.access import meeting_facts

router = APIRouter(tags=["meetings"])

Identity = Annotated[RequestIdentity, Depends(current_identity)]
Db = Annotated[Database, Depends(get_database)]

_NOT_FOUND = "Meeting not found."
SUGGESTION_SOURCES = 500  # most recent named meetings read for suggestions
MAX_BODY_BYTES = 8 * 1024  # a full map: labels × (label + 60 chars)


@router.patch("/meetings/{meeting_id}/speakers")
async def set_speaker_names(
    meeting_id: str, request: Request, identity: Identity, db: Db
) -> dict[str, Any]:
    mid = path_id(meeting_id, _NOT_FOUND)
    enforce_limit(request.app.state.content_limiter, identity.user_id)  # like a notes edit
    body = await json_object(request, max_bytes=MAX_BODY_BYTES)
    async with db.role_transaction(SERVICE) as conn:
        facts = await meeting_facts(conn, mid, identity.user_id, lock=True)
        if facts is None or facts.role is None:  # never confirm a meeting the caller cannot see
            raise NotFound(_NOT_FOUND)
        if not has_role(facts.role, "editor"):
            raise Forbidden("Forbidden.")
        labels = {
            r[0]
            for r in await conn.execute(
                text(
                    "SELECT DISTINCT speaker FROM public.transcript_segments "
                    "WHERE meeting_id = :id AND speaker IS NOT NULL"
                ),
                {"id": mid},
            )
        }
        current = clean_names(
            jsonb(
                (
                    await conn.execute(  # the row is locked by meeting_facts(lock=True)
                        text("SELECT speaker_names FROM public.meetings WHERE id = :id"),
                        {"id": mid},
                    )
                ).scalar_one_or_none()
            )
        )
        changes = parse_speaker_patch(body, labels, current.keys())
        names = merge_names(current, changes)
        await conn.execute(
            text("UPDATE public.meetings SET speaker_names = CAST(:n AS jsonb) WHERE id = :id"),
            {"n": json.dumps(names), "id": mid},
        )
    return {"speakerNames": names}


@router.get("/speakers/suggestions")
async def speaker_suggestions(identity: Identity, db: Db) -> dict[str, list[str]]:
    async with db.app_transaction(identity) as conn:  # RLS: meetings the caller can see
        rows = (
            await conn.execute(
                text(
                    "SELECT speaker_names FROM public.meetings WHERE speaker_names <> '{}'::jsonb "
                    "ORDER BY updated_at DESC LIMIT :n"
                ),
                {"n": SUGGESTION_SOURCES},
            )
        ).scalars()
        maps = [clean_names(jsonb(r)) for r in rows]
    return {"names": rank_suggestions(maps)}
