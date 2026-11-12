"""To-dos and calendar suggestions (ARC-07): status changes (editor+), .ics file (viewer+)."""

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.auth.deps import current_identity
from app.core.errors import AppError, Forbidden, NotFound, UnprocessableEntity
from app.db.context import RequestIdentity
from app.db.session import Database, get_database
from app.domain.access import Role, has_role
from app.domain.ics import IcsError, build_suggestion_ics, ics_filename
from app.domain.rules import parse_dismissed, parse_todo_status
from app.routers._common import SERVICE, json_object, path_id
from app.services.access import meeting_facts

router = APIRouter(tags=["meetings"])

Identity = Annotated[RequestIdentity, Depends(current_identity)]
Db = Annotated[Database, Depends(get_database)]


class IcsFailed(AppError):
    status = 500
    code = "internal"
    message = "Failed to generate calendar file."


async def _require_parent(
    conn: AsyncConnection, meeting_id: uuid.UUID, identity: RequestIdentity, minimum: Role
) -> None:
    facts = await meeting_facts(conn, meeting_id, identity.user_id)
    if facts is None:
        raise NotFound("Parent meeting not found.")
    if not has_role(facts.role, minimum):
        raise Forbidden("Forbidden.")


@router.patch("/todos/{todo_id}")
async def update_todo(
    todo_id: str, request: Request, identity: Identity, db: Db
) -> dict[str, bool]:
    status = parse_todo_status(await json_object(request))
    tid = path_id(todo_id, "Todo not found.")
    async with db.role_transaction(SERVICE) as conn:
        meeting = (
            await conn.execute(
                text("SELECT meeting_id FROM public.todos WHERE id = :id FOR UPDATE"), {"id": tid}
            )
        ).scalar_one_or_none()
        if meeting is None:
            raise NotFound("Todo not found.")
        await _require_parent(conn, meeting, identity, "editor")
        await conn.execute(
            text("UPDATE public.todos SET status = :s WHERE id = :id"), {"s": status, "id": tid}
        )
    return {"ok": True}


@router.patch("/calendar-suggestions/{suggestion_id}")
async def dismiss_suggestion(
    suggestion_id: str, request: Request, identity: Identity, db: Db
) -> dict[str, bool]:
    parse_dismissed(await json_object(request))
    sid = path_id(suggestion_id, "Suggestion not found.")
    async with db.role_transaction(SERVICE) as conn:
        meeting = (
            await conn.execute(
                text(
                    "SELECT meeting_id FROM public.calendar_suggestions WHERE id = :id FOR UPDATE"
                ),
                {"id": sid},
            )
        ).scalar_one_or_none()
        if meeting is None:
            raise NotFound("Suggestion not found.")
        await _require_parent(conn, meeting, identity, "editor")
        await conn.execute(
            text("UPDATE public.calendar_suggestions SET dismissed = true WHERE id = :id"),
            {"id": sid},
        )
    return {"ok": True}


@router.get("/calendar-suggestions/{suggestion_id}/ics")
async def suggestion_ics(suggestion_id: str, identity: Identity, db: Db) -> Response:
    sid = path_id(suggestion_id, "Suggestion not found.")
    async with db.role_transaction(SERVICE) as conn:
        row = (
            await conn.execute(
                text(
                    "SELECT id, meeting_id, title, proposed_at, raw_mention "
                    "FROM public.calendar_suggestions WHERE id = :id"
                ),
                {"id": sid},
            )
        ).first()
        if row is None:
            raise NotFound("Suggestion not found.")
        await _require_parent(conn, row.meeting_id, identity, "viewer")
    suggestion: dict[str, Any] = dict(row._mapping)
    if suggestion["proposed_at"] is None:
        raise UnprocessableEntity(
            "This event has no specific date/time — cannot generate a calendar file. "
            "Add the event to your calendar manually."
        )
    try:
        body = build_suggestion_ics(suggestion, datetime.now(UTC))
    except IcsError as exc:
        raise IcsFailed(detail=str(exc)) from None
    filename = ics_filename(suggestion["title"] or "")
    return Response(
        content=body,
        media_type="text/calendar; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
