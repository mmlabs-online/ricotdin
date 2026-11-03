"""Chat request, scope and retrieved-row rules (ARC-09; port of v1 ``lib/rag/scope.ts`` and the
filters of ``lib/rag/retrieve.ts``). Pure.

Three scopes: one meeting, a folder (the meetings in it the caller can see) or global (every
meeting the caller can see; RLS on ``transcript_chunks`` limits the search).
"""

import math
import re
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from app.core.errors import BadRequest

MAX_MESSAGE_CHARS = 4000  # v2: v1 had no limit
MATCH_COUNT = 8  # v1
SIMILARITY_FLOOR = 0.5  # v1: below this cosine similarity a chunk is off-topic noise
HISTORY_TURNS = 4  # v1: the last 4 messages before the question
HISTORY_CHARS = 2000  # per message in the prompt

_UNSAFE = re.compile("[\x00\ud800-\udfff]")  # NUL and lone surrogates: Postgres / UTF-8 reject

Outcome = Literal["answer", "no_context", "retrieval_error"]


@dataclass(frozen=True)
class ChatRequest:
    message: str
    meeting_id: str | None
    folder_id: str | None
    session_id: str | None


@dataclass(frozen=True)
class RetrievedChunk:
    id: uuid.UUID
    meeting_id: uuid.UUID
    content: str
    start_ms: int
    end_ms: int
    similarity: float


@dataclass(frozen=True)
class HistoryMessage:
    role: str  # 'user' | 'assistant'
    content: str


def clean_text(value: str) -> str:
    return _UNSAFE.sub("", value)


def _anchor(value: Any) -> str | None:
    # v1: a non-string is ignored and an empty string means "not set"
    return value if isinstance(value, str) and value else None


def parse_chat_request(body: dict[str, Any]) -> ChatRequest:
    raw = body.get("message")
    message = clean_text(raw).strip() if isinstance(raw, str) else ""
    if not message:
        raise BadRequest("message is required.")
    if len(message) > MAX_MESSAGE_CHARS:
        raise BadRequest(f"message is too long (at most {MAX_MESSAGE_CHARS} characters).")
    meeting, folder = _anchor(body.get("meetingId")), _anchor(body.get("folderId"))
    if meeting and folder:
        raise BadRequest("Provide meetingId or folderId, not both.")
    return ChatRequest(message, meeting, folder, _anchor(body.get("sessionId")))


def derive_meeting_ids(
    meeting_id: uuid.UUID | None, folder_meeting_ids: list[uuid.UUID] | None
) -> list[uuid.UUID] | None:
    """The retrieval filter: ``[meeting]``, the folder's visible meetings, or None (global)."""
    if meeting_id is not None:
        return [meeting_id]
    if folder_meeting_ids is not None:
        return list(folder_meeting_ids)
    return None


def classify_outcome(retrieval_failed: bool, chunk_count: int) -> Outcome:
    """A technical retrieval failure is never reported as "nothing relevant" (v1)."""
    if retrieval_failed:
        return "retrieval_error"
    return "answer" if chunk_count > 0 else "no_context"


def session_matches(
    session_meeting: uuid.UUID | None,
    session_folder: uuid.UUID | None,
    meeting_id: uuid.UUID | None,
    folder_id: uuid.UUID | None,
) -> bool:
    """A session continues only in its own scope (v2; v1 let any own session be reused, so a
    meeting chat could be continued as a folder or global chat)."""
    return session_meeting == meeting_id and session_folder == folder_id


def _usable(c: RetrievedChunk) -> bool:
    return math.isfinite(c.similarity) and 0 <= c.start_ms <= c.end_ms


def keep_chunks(
    rows: Sequence[RetrievedChunk], meeting_ids: list[uuid.UUID] | None
) -> list[RetrievedChunk]:
    """Similarity floor (v1), plus — on top of RLS — only rows of the requested meetings."""
    allowed = set(meeting_ids) if meeting_ids is not None else None
    kept = [
        c
        for c in rows
        if _usable(c)
        and c.similarity >= SIMILARITY_FLOOR
        and (allowed is None or c.meeting_id in allowed)
    ]
    return kept[:MATCH_COUNT]


def recent_history(rows_newest_first: Sequence[tuple[str, str]]) -> list[HistoryMessage]:
    """The last ``HISTORY_TURNS`` messages before the question, oldest first, each bounded."""
    picked = [
        HistoryMessage(role, content[:HISTORY_CHARS])
        for role, content in rows_newest_first
        if role in ("user", "assistant")
    ][:HISTORY_TURNS]
    return list(reversed(picked))
