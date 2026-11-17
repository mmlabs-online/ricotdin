"""Library-wide search (PRO-05): ``GET /search?q&folderId``.

Runs as ``ricotdin_app``, so RLS keeps every row to the meetings the caller can see (owner, folder
owner or share). Keyword hits: every term (accent- and case-insensitive through
``public.ricotdin_fold``) in a transcript segment, the summary or the notes. Semantic hits: the
query embedded once (``embed-query``; no quota charge) against ``match_transcript_chunks``. An
embedding failure keeps the keyword results (``semanticAvailable: false``). Pure parts:
``app/domain/search.py``."""

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.auth.deps import current_identity
from app.core.logging import get_logger
from app.core.ratelimit import RateLimiter
from app.db.context import RequestIdentity
from app.db.session import Database, get_database
from app.domain.search import (
    KeywordHit,
    Kind,
    SearchQuery,
    SemanticHit,
    fold,
    fuse,
    like_term,
    parse_search,
    term_hits,
)
from app.rag.scope import MATCH_COUNT, SIMILARITY_FLOOR
from app.routers._common import SERVICE, enforce_limit
from app.services.ai.service import UsageContext
from app.worker.embed import vector_literal

router = APIRouter(tags=["search"])
log = get_logger("app.search")

Identity = Annotated[RequestIdentity, Depends(current_identity)]
Db = Annotated[Database, Depends(get_database)]

SEARCHES_PER_MINUTE = 30
SEGMENT_CANDIDATES = 200
MEETING_CANDIDATES = 50
_TOO_MANY = "Too many searches. Wait a minute."


def search_limiter() -> RateLimiter:
    return RateLimiter(capacity=SEARCHES_PER_MINUTE, refill_per_second=SEARCHES_PER_MINUTE / 60)


def _all_terms(column: str, n: int) -> str:
    """``ricotdin_fold(<column>) LIKE :t0 AND …``: only fixed column names and indices go in."""
    return " AND ".join(f"public.ricotdin_fold({column}) LIKE :t{i} ESCAPE '\\'" for i in range(n))


async def _keyword(conn: AsyncConnection, q: SearchQuery) -> list[KeywordHit]:
    args: dict[str, Any] = {f"t{i}": like_term(t) for i, t in enumerate(q.terms)}
    args["f"] = q.folder_id
    folder = "AND m.folder_id = :f " if q.folder_id else ""
    n = len(q.terms)
    segments = (
        await conn.execute(
            text(
                "SELECT s.meeting_id, s.start_ms, s.end_ms, s.text "  # noqa: S608
                "FROM public.transcript_segments s "
                "JOIN public.meetings m ON m.id = s.meeting_id "
                f"WHERE {_all_terms('s.text', n)} {folder}"
                "ORDER BY m.created_at DESC, s.segment_index LIMIT :lim"
            ),
            {**args, "lim": SEGMENT_CANDIDATES},
        )
    ).all()
    meetings = (
        await conn.execute(
            text(
                "SELECT m.id, m.summary, m.notes FROM public.meetings m "  # noqa: S608
                f"WHERE (({_all_terms('m.summary', n)}) OR ({_all_terms('m.notes', n)})) {folder}"
                "ORDER BY m.created_at DESC LIMIT :lim"
            ),
            {**args, "lim": MEETING_CANDIDATES},
        )
    ).all()
    hits = [
        KeywordHit(r.meeting_id, "transcript", int(r.start_ms), int(r.end_ms), r.text,
                   term_hits(r.text, q.terms))
        for r in segments
    ]  # fmt: skip
    for r in meetings:
        fields: tuple[tuple[Kind, str | None], ...] = (("summary", r.summary), ("notes", r.notes))
        for kind, body in fields:
            folded = fold(body or "")
            if body and all(t in folded for t in q.terms):
                hits.append(KeywordHit(r.id, kind, None, None, body, term_hits(body, q.terms)))
    return hits


async def _semantic(
    request: Request, db: Database, identity: RequestIdentity, q: SearchQuery
) -> list[SemanticHit]:
    ids: list[uuid.UUID] | None = None
    if q.folder_id:
        async with db.app_transaction(identity) as conn:
            ids = list(
                (
                    await conn.execute(
                        text("SELECT id FROM public.meetings WHERE folder_id = :f"),
                        {"f": q.folder_id},
                    )
                ).scalars()
            )
        if not ids:
            return []
    (vector,) = await request.app.state.ai.embed(
        db, SERVICE, [q.text], operation="embed-query", usage=UsageContext(None, identity.user_id)
    )
    async with db.app_transaction(identity) as conn:  # RLS on transcript_chunks
        rows = (
            await conn.execute(
                text(
                    "SELECT meeting_id, content, start_ms, end_ms, similarity FROM "
                    "public.match_transcript_chunks(CAST(:e AS vector), :n, CAST(:ids AS uuid[]))"
                ),
                {"e": vector_literal(vector), "n": MATCH_COUNT, "ids": ids},
            )
        ).all()
    return [
        SemanticHit(r.meeting_id, int(r.start_ms or 0), int(r.end_ms or 0), r.content or "",
                    float(r.similarity))
        for r in rows
        if r.similarity is not None and float(r.similarity) >= SIMILARITY_FLOOR
    ]  # fmt: skip


@router.get("/search")
async def search(request: Request, identity: Identity, db: Db) -> dict[str, Any]:
    q = parse_search(request.query_params)
    enforce_limit(
        request.app.state.search_limiter, identity.user_id, "Too many searches. Wait a minute."
    )
    async with db.app_transaction(identity) as conn:
        keyword = await _keyword(conn, q)
    semantic_ok = True
    try:
        semantic = await _semantic(request, db, identity, q)
    except Exception as exc:  # noqa: BLE001 - any embedding / vector failure keeps keyword results
        semantic_ok, semantic = False, []
        log.warning("search: semantic part failed (%s)", type(exc).__name__)
    groups = fuse(keyword, semantic, q.terms)
    meta: dict[uuid.UUID, Any] = {}
    if groups:
        async with db.app_transaction(identity) as conn:
            meta = {
                r.id: r
                for r in await conn.execute(
                    text(
                        "SELECT id, title, created_at FROM public.meetings "
                        "WHERE id = ANY(CAST(:ids AS uuid[]))"
                    ),
                    {"ids": [g.meeting_id for g in groups]},
                )
            }
    return {
        "query": q.text,
        "semanticAvailable": semantic_ok,
        "groups": [
            {
                "meetingId": str(g.meeting_id),
                "title": meta[g.meeting_id].title,
                "createdAt": meta[g.meeting_id].created_at,
                "items": [
                    {
                        "kind": i.kind,
                        "startMs": i.start_ms,
                        "text": i.text,
                        "ranges": [list(r) for r in i.ranges],
                        "source": i.source,
                    }
                    for i in g.items
                ],  # fmt: skip
            }
            for g in groups
            if g.meeting_id in meta  # a meeting deleted meanwhile drops out
        ],
    }
