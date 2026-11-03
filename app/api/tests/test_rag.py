"""ARC-09 pure chat/RAG logic. Ports of v1 ``tests/rag.test.ts`` (citation filter),
``tests/rag-folder.test.ts`` (scope derivation, outcome) and the v2 rules: request parsing,
session/scope match, similarity floor + scope filter on retrieved rows, citations rebuilt from the
retrieved chunks (never from model numbers), bounded untrusted answer."""

import json
import math
import uuid
from typing import Any

import pytest

from app.core.errors import BadRequest
from app.rag.answer import (
    ANSWER_SCHEMA,
    MAX_ANSWER_CHARS,
    SYSTEM_PROMPT,
    HistoryMessage,
    build_user_content,
    parse_answer,
)
from app.rag.scope import (
    MATCH_COUNT,
    MAX_MESSAGE_CHARS,
    SIMILARITY_FLOOR,
    RetrievedChunk,
    classify_outcome,
    derive_meeting_ids,
    keep_chunks,
    parse_chat_request,
    recent_history,
    session_matches,
)
from app.services.ai.service import ParseFailed

M1, M2, M3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()


def chunk(meeting: uuid.UUID = M1, sim: float = 0.9, **kw: Any) -> RetrievedChunk:
    base: dict[str, Any] = {"id": uuid.uuid4(), "meeting_id": meeting, "content": "hello",
                            "start_ms": 61_000, "end_ms": 65_000, "similarity": sim}  # fmt: skip
    base.update(kw)
    return RetrievedChunk(**base)


# --- request ----------------------------------------------------------------------------------------


def test_parse_request() -> None:
    req = parse_chat_request({"message": "  What was decided? ", "meetingId": str(M1)})
    assert req.message == "What was decided?"
    assert (req.meeting_id, req.folder_id, req.session_id) == (str(M1), None, None)
    # v1: non-string anchors are ignored; an empty string means "not set"
    req = parse_chat_request({"message": "q", "meetingId": 5, "folderId": "", "sessionId": None})
    assert (req.meeting_id, req.folder_id, req.session_id) == (None, None, None)


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({}, "message is required."),
        ({"message": "   "}, "message is required."),
        ({"message": 3}, "message is required."),
        ({"message": "q", "meetingId": "a", "folderId": "b"},
         "Provide meetingId or folderId, not both."),
        ({"message": "x" * (MAX_MESSAGE_CHARS + 1)},
         f"message is too long (at most {MAX_MESSAGE_CHARS} characters)."),
    ],
)  # fmt: skip
def test_parse_request_errors(body: dict[str, Any], message: str) -> None:
    with pytest.raises(BadRequest) as err:
        parse_chat_request(body)
    assert err.value.public_message == message


def test_message_limit_and_unsafe_characters() -> None:
    assert MAX_MESSAGE_CHARS == 4000
    assert parse_chat_request({"message": "x" * MAX_MESSAGE_CHARS}).message == "x" * 4000
    # NUL / lone surrogates would make Postgres reject the insert: removed
    assert parse_chat_request({"message": "a\x00b\ud800c"}).message == "abc"


# --- scope (v1 rag-folder.test.ts) -----------------------------------------------------------------


def test_derive_meeting_ids() -> None:
    assert derive_meeting_ids(M1, None) == [M1]
    assert derive_meeting_ids(None, [M1, M2]) == [M1, M2]
    assert derive_meeting_ids(None, []) == []
    assert derive_meeting_ids(None, None) is None  # global: RLS limits the search
    assert derive_meeting_ids(M1, [M2]) == [M1]  # meeting wins (defensive)


def test_classify_outcome() -> None:
    assert classify_outcome(True, 0) == "retrieval_error"
    assert classify_outcome(True, 5) == "retrieval_error"  # a failure is never "no context"
    assert classify_outcome(False, 0) == "no_context"
    assert classify_outcome(False, 1) == "answer"


def test_session_must_match_the_request_scope() -> None:
    f = uuid.uuid4()
    assert session_matches(M1, None, M1, None)
    assert session_matches(None, f, None, f)
    assert session_matches(None, None, None, None)
    assert not session_matches(M1, None, M2, None)
    assert not session_matches(M1, None, None, None)  # a meeting chat reused as global
    assert not session_matches(None, None, M1, None)
    assert not session_matches(None, f, None, None)


# --- retrieved rows ----------------------------------------------------------------------------------


def test_keep_chunks_applies_the_floor_and_the_scope() -> None:
    assert (MATCH_COUNT, SIMILARITY_FLOOR) == (8, 0.5)
    near, edge, far = chunk(sim=0.9), chunk(sim=0.5), chunk(sim=0.49)
    other = chunk(meeting=M3, sim=0.99)
    assert keep_chunks([near, edge, far], None) == [near, edge]
    # defence in depth on top of RLS: a row outside the requested meetings is dropped
    assert keep_chunks([other, near], [M1, M2]) == [near]
    assert keep_chunks([near], []) == []
    bad = [
        chunk(sim=math.nan),
        chunk(sim=math.inf),
        chunk(start_ms=-1),
        chunk(end_ms=10, start_ms=20),
    ]
    assert keep_chunks(bad, None) == []
    many = [chunk(sim=0.9 - i / 100) for i in range(12)]
    assert keep_chunks(many, None) == many[:MATCH_COUNT]


def test_recent_history_is_chronological_and_bounded() -> None:
    rows = [("assistant", "a2"), ("user", "q2"), ("assistant", "a1"), ("user", "q1"),
            ("assistant", "a0")]  # newest first, as read  # fmt: skip
    assert recent_history(rows) == [
        HistoryMessage("user", "q1"), HistoryMessage("assistant", "a1"),
        HistoryMessage("user", "q2"), HistoryMessage("assistant", "a2"),
    ]  # fmt: skip
    long = recent_history([("user", "y" * 10_000)])
    assert len(long[0].content) == 2_000
    assert recent_history([("system", "x")]) == []


# --- prompt -------------------------------------------------------------------------------------------


def test_prompt_carries_excerpts_history_and_question() -> None:
    c = chunk()
    text = build_user_content("Who owns the launch?", [c], [HistoryMessage("user", "earlier")])
    assert f"chunk_id={c.id} meeting_id={M1} start_ms=61000 end_ms=65000\nhello" in text
    assert "User: earlier" in text and text.rstrip().endswith("Who owns the launch?")
    assert "ONLY" in SYSTEM_PROMPT and "chunk_id" in SYSTEM_PROMPT
    assert "untrusted" in SYSTEM_PROMPT.lower()  # excerpts are data, not instructions
    assert ANSWER_SCHEMA["required"] == ["answer", "citations"]


# --- answer (v1 rag.test.ts filterValidCitations) ------------------------------------------------------


def _raw(answer: Any, citations: Any) -> str:
    return json.dumps({"answer": answer, "citations": citations})


def test_invented_citations_are_dropped_and_rebuilt_from_the_chunk() -> None:
    a, b = chunk(), chunk(meeting=M2, start_ms=0, end_ms=1_000)
    raw = _raw("They agreed.", [
        {"chunk_id": str(a.id), "meeting_id": str(M3), "start_ms": 999_999, "end_ms": 0},
        {"chunk_id": str(uuid.uuid4())},  # invented
        {"chunk_id": str(b.id)},
        {"chunk_id": str(a.id)},  # duplicate
        "junk", {"chunk_id": 7},
    ])  # fmt: skip
    ans = parse_answer(raw, [a, b])
    assert ans.text == "They agreed."
    assert ans.citations == [
        {"chunk_id": str(a.id), "meeting_id": str(M1), "start_ms": 61_000, "end_ms": 65_000},
        {"chunk_id": str(b.id), "meeting_id": str(M2), "start_ms": 0, "end_ms": 1_000},
    ]


def test_answer_parse_is_defensive() -> None:
    c = chunk()
    assert parse_answer("```json\n" + _raw("ok", []) + "\n```", [c]).text == "ok"
    assert parse_answer(_raw("ok", "not a list"), [c]).citations == []
    assert parse_answer(_raw("a\x00b", []), [c]).text == "ab"
    assert len(parse_answer(_raw("z" * (MAX_ANSWER_CHARS + 5), []), [c]).text) == MAX_ANSWER_CHARS
    for raw in ("not json", "[]", _raw("", []), _raw("   ", []), _raw(None, []), "null"):
        with pytest.raises(ParseFailed):
            parse_answer(raw, [c])
