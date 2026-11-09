"""Chat over meeting transcripts (ARC-09; port of v1 ``app/api/chat/route.ts``).

``POST /chat`` answers a question about one meeting (``meetingId``), a folder (``folderId``) or
every meeting the caller can see (neither), with citations to transcript chunks. ``GET /chat``
returns the latest session of a meeting or folder (or the session ``sessionId``) with its messages.

Access (v1 status codes): meeting → viewer+ (404 unknown, 403 no role); folder → owner or any
share (403 otherwise); a session → its owner only and only in its own scope (v2). The question
is embedded with the pinned embedding model; the vector search runs as ``ricotdin_app`` with the
caller's RLS context, so ``transcript_chunks`` only yields meetings the caller can see, and the
rows are filtered again by the requested meetings (``keep_chunks``). Chat writes run as
``ricotdin_service`` after these checks (the app role has SELECT only on chat tables).

Quota (v1 QUO-03, actor pays): one agent query per question, charged before retrieval with the
user message (402 ``insufficient_agent_balance`` when none is left: nothing is saved); refunded
when retrieval or the answer fails. "Nothing relevant" is charged (v1); an empty folder is not.
Model (v1 AIP-03/04): a meeting chat uses the meeting's locked model, else the system default; a
folder or global chat uses the system default. AI calls hold no database connection.
"""

import json
import uuid
from typing import Annotated, Any

import anyio
from fastapi import APIRouter, Depends, Request
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection

from app.auth.deps import current_identity
from app.core.errors import AppError, BadRequest, Forbidden, NotFound
from app.core.logging import get_logger
from app.core.ratelimit import RateLimiter
from app.db.context import RequestIdentity
from app.db.session import Database, get_database
from app.domain.access import has_role
from app.domain.models import Pick, system_default
from app.domain.rules import parse_uuid
from app.rag.answer import (
    ANSWER_SCHEMA,
    SYSTEM_PROMPT,
    answer_refund_reason,
    build_user_content,
    parse_answer,
)
from app.rag.scope import (
    MATCH_COUNT,
    RetrievedChunk,
    classify_outcome,
    derive_meeting_ids,
    keep_chunks,
    parse_chat_request,
    recent_history,
    session_matches,
)
from app.routers._common import SERVICE, as_dict, enforce_limit, json_object, jsonb
from app.routers.meetings import record_activity
from app.services.access import folder_viewable, meeting_facts
from app.services.ai.model_lock import stored_pick
from app.services.ai.service import AIService, UsageContext
from app.worker.embed import vector_literal

router = APIRouter(tags=["chat"])
log = get_logger("chat")

Identity = Annotated[RequestIdentity, Depends(current_identity)]
Db = Annotated[Database, Depends(get_database)]

CHAT_PER_WINDOW = 30  # questions per user per 10 minutes (v2; v1 relied on the quota only)
CHAT_WINDOW_S = 600
MAX_BODY_BYTES = 64 * 1024  # a 4000-character question is well below this

NO_CONTEXT_REPLY = (
    "I couldn't find relevant information in the meeting transcript to answer that question. "
    "Try rephrasing, or check that the meeting has finished processing."
)
# Distinct from NO_CONTEXT_REPLY so an outage is never mistaken for "nothing relevant" (v1).
RETRIEVAL_ERROR_REPLY = (
    "Sorry — I couldn't search this meeting right now due to a temporary problem with the "
    "search service. This is not a problem with the meeting content. Please try again in a "
    "moment; if it persists, an administrator can check the AI provider keys and logs."
)
EMPTY_FOLDER_REPLY = (
    "This folder has no meetings with transcripts yet. "
    "Add some meetings and process them before asking questions here."
)
ANSWER_ERROR_REPLY = "I encountered an error while generating an answer. Please try again."

_MEETING_NOT_FOUND = "Meeting not found."
_SESSION_NOT_FOUND = "Session not found."
_FORBIDDEN = "Forbidden."
_WRONG_SCOPE = "This chat session belongs to another meeting or folder."
_MESSAGE_COLUMNS = "id, session_id, role, content, citations, created_at"
_QUOTA = (
    "SELECT status, agent_remaining FROM public.quota_apply_movement(:u, 0, :d, :reason, :key, "
    "false, :m, :u, CAST(:md AS jsonb))"
)


class AgentQuotaBlocked(AppError):
    status = 402
    code = "insufficient_agent_balance"
    message = "You have no chat questions left. Please contact an administrator."

    def __init__(self, remaining: int) -> None:
        super().__init__()
        self.remaining = remaining

    def extra(self) -> dict[str, Any]:
        return {"remaining_queries": self.remaining}


def chat_limiter() -> RateLimiter:
    return RateLimiter(capacity=CHAT_PER_WINDOW, refill_per_second=CHAT_PER_WINDOW / CHAT_WINDOW_S)


def _message(row: Any) -> dict[str, Any]:
    out = as_dict(row) or {}
    out["citations"] = jsonb(out.get("citations")) or []
    return out


async def _system_default(conn: AsyncConnection) -> Pick:
    raw = (
        await conn.execute(
            text("SELECT value FROM public.app_settings WHERE key = 'generation.system_default'")
        )
    ).scalar_one_or_none()
    return system_default(jsonb(raw))


async def _check_meeting(conn: AsyncConnection, mid: uuid.UUID, me: uuid.UUID) -> Pick | None:
    """Viewer+ check; returns the meeting's locked model (None when it has none)."""
    facts = await meeting_facts(conn, mid, me)
    if facts is None:
        raise NotFound(_MEETING_NOT_FOUND)
    if not has_role(facts.role, "viewer"):
        raise Forbidden(_FORBIDDEN)
    row = (
        await conn.execute(
            text(
                "SELECT generation_provider, generation_model FROM public.meetings WHERE id = :id"
            ),
            {"id": mid},
        )
    ).one()
    return stored_pick(row[0], row[1])


async def _check_folder(conn: AsyncConnection, fid: uuid.UUID, me: uuid.UUID) -> None:
    if not await folder_viewable(conn, fid, me):
        raise Forbidden(_FORBIDDEN)


def _ids(
    meeting: str | None, folder: str | None, session: str | None
) -> tuple[uuid.UUID | None, uuid.UUID | None, uuid.UUID | None]:
    # Ids that are not UUIDs cannot exist: the same answers as an unknown id (v1).
    mid = parse_uuid(meeting) if meeting else None
    if meeting and mid is None:
        raise NotFound(_MEETING_NOT_FOUND)
    fid = parse_uuid(folder) if folder else None
    if folder and fid is None:
        raise Forbidden(_FORBIDDEN)
    sid = parse_uuid(session) if session else None
    if session and sid is None:
        raise NotFound(_SESSION_NOT_FOUND)
    return mid, fid, sid


async def _messages(conn: AsyncConnection, sid: uuid.UUID) -> list[dict[str, Any]]:
    rows = (
        await conn.execute(
            text(
                f"SELECT {_MESSAGE_COLUMNS} FROM public.chat_messages "  # noqa: S608 - constant
                "WHERE session_id = :s ORDER BY created_at, id"
            ),
            {"s": sid},
        )
    ).all()
    return [_message(r) for r in rows]


# --- GET /chat ------------------------------------------------------------------------------------


@router.get("/chat")
async def chat_history(
    identity: Identity,
    db: Db,
    meetingId: str | None = None,  # noqa: N803 - v1 query parameter names
    folderId: str | None = None,  # noqa: N803
    sessionId: str | None = None,  # noqa: N803
) -> dict[str, Any]:
    """The latest session of a meeting (viewer+) or folder (owner or share) with its messages,
    or the caller's session ``sessionId`` (access to its meeting/folder re-checked). Without a
    parameter: no session (v1)."""
    me = identity.user_id
    mid, fid, sid = _ids(meetingId or None, folderId or None, sessionId or None)
    async with db.role_transaction(SERVICE) as conn:
        if mid is not None:
            await _check_meeting(conn, mid, me)
            where, params = "meeting_id = :a", {"a": mid}
        elif fid is not None:
            await _check_folder(conn, fid, me)
            where, params = "folder_id = :a AND meeting_id IS NULL", {"a": fid}
        elif sid is not None:
            where, params = "id = :a", {"a": sid}
        else:
            return {"sessionId": None, "messages": []}
        session = (
            await conn.execute(
                text(
                    "SELECT id, meeting_id, folder_id FROM public.chat_sessions "  # noqa: S608
                    f"WHERE user_id = :me AND {where} ORDER BY created_at DESC, id LIMIT 1"
                ),
                {"me": me, **params},
            )
        ).first()
        if session is None:
            if sid is not None:
                raise NotFound(_SESSION_NOT_FOUND)  # someone else's session looks unknown
            return {"sessionId": None, "messages": []}
        if sid is not None and session.meeting_id is not None:
            await _check_meeting(conn, session.meeting_id, me)
        elif sid is not None and session.folder_id is not None:
            await _check_folder(conn, session.folder_id, me)
        return {"sessionId": session.id, "messages": await _messages(conn, session.id)}


# --- POST /chat -----------------------------------------------------------------------------------


@router.post("/chat")
async def chat(request: Request, identity: Identity, db: Db) -> dict[str, Any]:
    me = identity.user_id
    enforce_limit(request.app.state.chat_limiter, me)
    req = parse_chat_request(await json_object(request, max_bytes=MAX_BODY_BYTES))
    mid, fid, sid = _ids(req.meeting_id, req.folder_id, req.session_id)

    # The folder's meetings the caller can see (RLS); the access check comes first and is
    # repeated in the service transaction below.
    folder_meetings: list[uuid.UUID] | None = None
    if fid is not None:
        async with db.role_transaction(SERVICE) as conn:
            await _check_folder(conn, fid, me)
        async with db.app_transaction(identity) as conn:
            rows = await conn.execute(
                text("SELECT id FROM public.meetings WHERE folder_id = :f"), {"f": fid}
            )
            folder_meetings = [r[0] for r in rows]
    meeting_ids = derive_meeting_ids(mid, folder_meetings)
    msg_id = uuid.uuid4()  # also the quota dedup key: a charge and its refund apply once

    async with db.role_transaction(SERVICE) as conn:
        if mid is not None:
            pick = await _check_meeting(conn, mid, me) or await _system_default(conn)
        else:
            if fid is not None:
                await _check_folder(conn, fid, me)
            pick = await _system_default(conn)
        session_id = await _session(conn, me, sid, mid, fid)
        history_rows = (
            await conn.execute(
                text(
                    "SELECT role::text, content FROM public.chat_messages WHERE session_id = :s "
                    "ORDER BY created_at DESC, id DESC LIMIT 8"
                ),
                {"s": session_id},
            )
        ).all()
        history = recent_history([(r[0], r[1]) for r in history_rows])
        await conn.execute(
            text(
                "INSERT INTO public.chat_messages (id, session_id, role, content, created_at) "
                "VALUES (:id, :s, 'user', :c, clock_timestamp())"
            ),
            {"id": msg_id, "s": session_id, "c": req.message},
        )
        if meeting_ids == []:  # empty folder: answered without a charge or an AI call (v1)
            reply = await _save_reply(conn, session_id, EMPTY_FOLDER_REPLY, [])
        else:
            reply = None
            md = {"session_id": str(session_id), **({"folder_id": str(fid)} if fid else {})}
            charge = (
                await conn.execute(
                    text(_QUOTA),
                    {"u": me, "d": -1, "reason": "agent_query", "key": f"agent:{msg_id}:charge",
                     "m": mid, "md": json.dumps(md)},
                )
            ).one()  # fmt: skip
            if charge.status == "insufficient":
                raise AgentQuotaBlocked(int(charge.agent_remaining or 0))  # rolls back the question
    activity = {"sessionId": str(session_id), **({"folderId": str(fid)} if fid else {})}
    if reply is not None:
        await record_activity(db, request, me, "chat_message", mid, activity)
        return {"sessionId": session_id, "message": reply}

    usage = UsageContext(mid, me)
    refund_key = f"agent:{msg_id}:refund"
    saved = False  # once the reply is committed, a late cancel never refunds it
    try:
        await record_activity(db, request, me, "chat_message", mid, activity)
        content, citations, failed = await _answer(
            request.app.state.ai, db, identity, req.message, meeting_ids, history, pick, usage
        )
        if failed:
            await _refund(db, me, refund_key, session_id, failed)
        async with db.role_transaction(SERVICE) as conn:
            reply = await _save_reply(conn, session_id, content, citations)
        saved = True
    except BaseException:
        if not saved:
            with anyio.CancelScope(shield=True), anyio.move_on_after(5):
                await _refund(db, me, refund_key, session_id, "request_failed")
        raise
    return {"sessionId": session_id, "message": reply}


async def _session(
    conn: AsyncConnection,
    me: uuid.UUID,
    sid: uuid.UUID | None,
    mid: uuid.UUID | None,
    fid: uuid.UUID | None,
) -> uuid.UUID:
    if sid is None:
        created: uuid.UUID = (
            await conn.execute(
                text(
                    "INSERT INTO public.chat_sessions (user_id, meeting_id, folder_id) "
                    "VALUES (:u, :m, :f) RETURNING id"
                ),
                {"u": me, "m": mid, "f": fid},
            )
        ).scalar_one()
        return created
    row = (
        await conn.execute(
            text(
                "SELECT user_id, meeting_id, folder_id FROM public.chat_sessions WHERE id = :id "
                "FOR UPDATE"
            ),
            {"id": sid},
        )
    ).first()
    if row is None:
        raise NotFound(_SESSION_NOT_FOUND)
    if row.user_id != me:
        raise Forbidden(_FORBIDDEN)  # v1
    if not session_matches(row.meeting_id, row.folder_id, mid, fid):
        raise BadRequest(_WRONG_SCOPE)
    await conn.execute(
        text("UPDATE public.chat_sessions SET updated_at = now() WHERE id = :id"), {"id": sid}
    )
    return sid


async def _save_reply(
    conn: AsyncConnection, session_id: uuid.UUID, content: str, citations: list[dict[str, Any]]
) -> dict[str, Any]:
    try:
        row = (
            await conn.execute(
                text(
                    "INSERT INTO public.chat_messages (session_id, role, content, citations, "  # noqa: S608
                    "created_at) VALUES (:s, 'assistant', :c, CAST(:cit AS jsonb), "
                    "clock_timestamp()) "
                    f"RETURNING {_MESSAGE_COLUMNS}"
                ),
                {"s": session_id, "c": content, "cit": json.dumps(citations)},
            )
        ).one()
    except IntegrityError:  # the session went away with its meeting/folder meanwhile
        raise NotFound(_SESSION_NOT_FOUND) from None
    return _message(row)


async def _answer(
    ai: AIService,
    db: Database,
    identity: RequestIdentity,
    question: str,
    meeting_ids: list[uuid.UUID] | None,
    history: Any,
    pick: Pick,
    usage: UsageContext,
) -> tuple[str, list[dict[str, Any]], str | None]:
    """(reply, citations, refund reason or None)."""
    retrieval_failed = False
    chunks: list[RetrievedChunk] = []
    try:
        chunks = await _retrieve(ai, db, identity, question, meeting_ids, usage)
    except Exception as exc:  # noqa: BLE001 - any failure is the honest "search broke" reply (v1)
        retrieval_failed = True
        log.error("chat retrieval failed (%s)", type(exc).__name__)
    outcome = classify_outcome(retrieval_failed, len(chunks))
    if outcome == "retrieval_error":
        return RETRIEVAL_ERROR_REPLY, [], "retrieval_failed"
    if outcome == "no_context":
        return NO_CONTEXT_REPLY, [], None
    try:
        answer = await ai.generate_json(
            db, SERVICE, pick[0], pick[1],
            system=SYSTEM_PROMPT,
            user=build_user_content(question, chunks, history),
            retry_user=None,
            schema=ANSWER_SCHEMA, schema_name="chat_answer", operation="chat",
            parse=lambda raw: parse_answer(raw, chunks),
            usage=usage,
        )  # fmt: skip
    except AppError as exc:
        log.error("chat answer failed (%s %s)", type(exc).__name__, exc.code)
        # A provider refusal stays charged; failures on our side are refunded (SEC-05).
        return ANSWER_ERROR_REPLY, [], answer_refund_reason(exc)
    return answer.text, answer.citations, None


async def _retrieve(
    ai: AIService,
    db: Database,
    identity: RequestIdentity,
    question: str,
    meeting_ids: list[uuid.UUID] | None,
    usage: UsageContext,
) -> list[RetrievedChunk]:
    (vector,) = await ai.embed(db, SERVICE, [question], operation="embed-query", usage=usage)
    # As ricotdin_app: RLS on transcript_chunks keeps only meetings the caller can see.
    async with db.app_transaction(identity) as conn:
        rows = (
            await conn.execute(
                text(
                    "SELECT id, meeting_id, content, start_ms, end_ms, similarity FROM "
                    "public.match_transcript_chunks(CAST(:e AS vector), :n, "
                    "CAST(:ids AS uuid[]))"
                ),
                {"e": vector_literal(vector), "n": MATCH_COUNT, "ids": meeting_ids},
            )
        ).all()
        owners = {
            r[0]: r[1]
            for r in await conn.execute(
                text(
                    "SELECT id, user_id FROM public.meetings WHERE id = ANY(CAST(:ids AS uuid[]))"
                ),
                {"ids": list({r.meeting_id for r in rows})},
            )
        }
    found = [
        RetrievedChunk(r.id, r.meeting_id, r.content or "", int(r.start_ms or 0),
                       int(r.end_ms or 0), float(r.similarity),
                       shared=owners.get(r.meeting_id) != identity.user_id)
        for r in rows
    ]  # fmt: skip
    return keep_chunks(found, meeting_ids)


async def _refund(
    db: Database, me: uuid.UUID, key: str, session_id: uuid.UUID, reason: str
) -> None:
    # meeting_id NULL: the meeting may be gone (ledger FK); idempotent by the dedup key.
    try:
        async with db.role_transaction(SERVICE) as conn:
            await conn.execute(
                text(_QUOTA),
                {"u": me, "d": 1, "reason": "refund", "key": key, "m": None,
                 "md": json.dumps({"reason": reason, "session_id": str(session_id)})},
            )  # fmt: skip
    except Exception as exc:  # noqa: BLE001 - never hides the original error; the ledger shows it
        log.error("chat refund failed (%s)", type(exc).__name__)
