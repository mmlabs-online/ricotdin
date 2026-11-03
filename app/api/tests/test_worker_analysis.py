"""ARC-08c pure helpers: analysis prompt + defensive parse (port of v1 ``pipeline-parse``
``GeminiAnalysisSchema`` cases, the ``assertAnalysisHasContent`` guard and ``analyze.ts``
formatting) and generation-model resolution (v1 ``aip-control-plane`` / ``aip-model-lock``)."""

from datetime import UTC, date, datetime
from typing import Any

import pytest

from app.domain.models import parse_pick, resolve_generation_model, system_default
from app.services.ai.analysis import (
    ANALYSIS_SCHEMA,
    LIMITS,
    SegmentText,
    build_user_content,
    parse_analysis,
)
from app.services.ai.service import ParseFailed

GOOD: dict[str, Any] = {
    "summary": "Short meeting about roadmap.",
    "notes_markdown": "## Notes\n- Item 1",
    "todos": [
        {"content": "Write tests", "assignee": "Alice", "due_date": "2025-12-01",
         "source_segment_index": 3},
    ],
    "calendar_suggestions": [
        {"title": "Sync", "proposed_at": "2025-12-15T10:00:00Z", "raw_mention": "next Tuesday",
         "source_segment_index": 7},
    ],
}  # fmt: skip


def parse(obj: Any, segments: int = 10) -> Any:
    import json

    return parse_analysis(obj if isinstance(obj, str) else json.dumps(obj), segments)


# --- prompt ---------------------------------------------------------------------------------------


def test_user_content_lists_segments_with_index_speaker_and_seconds() -> None:
    segs = [SegmentText("Speaker 1", 0, "Hello"), SegmentText("Speaker 2", 1250, "Hi there")]
    text = build_user_content(segs, strict=False, meeting_date="2026-11-02T08:00:00+00:00")
    assert text == (
        "MEETING_DATE: 2026-11-02T08:00:00+00:00\n\n"
        "TRANSCRIPT (each line prefixed with its 0-based segment index [N]):\n"
        "[0] Speaker 1 (0.0s): Hello\n"
        "[1] Speaker 2 (1.3s): Hi there"
    )


def test_unknown_date_and_strict_suffix() -> None:
    text = build_user_content([SegmentText(None, 250, "x")], strict=True, meeting_date=None)
    assert text.startswith("MEETING_DATE: (unknown — do not guess or fabricate any dates)")
    assert "[0] Speaker (0.3s): x" in text  # JS toFixed(1) rounds half up
    assert text.endswith(
        "Return ONLY valid JSON matching the required schema. No markdown fences, no explanation."
    )


def test_schema_requires_all_four_fields() -> None:
    assert ANALYSIS_SCHEMA["required"] == ["summary", "notes_markdown", "todos",
                                           "calendar_suggestions"]  # fmt: skip
    todo = ANALYSIS_SCHEMA["properties"]["todos"]["items"]
    assert todo["properties"]["due_date"]["nullable"] is True


# --- parse --------------------------------------------------------------------------------------


def test_parses_a_well_formed_analysis() -> None:
    a = parse(GOOD)
    assert (a.summary, a.notes) == ("Short meeting about roadmap.", "## Notes\n- Item 1")
    (t,) = a.todos
    assert (t.content, t.assignee, t.due_date, t.segment_index) == (
        "Write tests", "Alice", date(2025, 12, 1), 3,
    )  # fmt: skip
    (c,) = a.calendar
    assert (c.title, c.proposed_at, c.raw_mention, c.segment_index) == (
        "Sync", datetime(2025, 12, 15, 10, tzinfo=UTC), "next Tuesday", 7,
    )  # fmt: skip


def test_code_fences_and_literal_newlines() -> None:
    raw = '```json\n{"summary": "a\\\\nb", "notes_markdown": "x\\\\ny", "todos": [], ' \
          '"calendar_suggestions": []}\n```'  # fmt: skip
    a = parse(raw)
    assert (a.summary, a.notes) == ("a\nb", "x\ny")


@pytest.mark.parametrize("raw", ["not json", "[1, 2]", '"text"', "null", "```"])
def test_unparseable_answers_ask_for_the_strict_retry(raw: str) -> None:
    with pytest.raises(ParseFailed):
        parse(raw)


@pytest.mark.parametrize("obj", [{}, {"summary": "  ", "notes_markdown": "\n"}, {"todos": []}])
def test_no_summary_and_no_notes_is_unusable(obj: Any) -> None:
    with pytest.raises(ParseFailed, match="empty summary and notes"):
        parse(obj)


def test_malformed_lists_and_items_are_dropped_not_fatal() -> None:
    a = parse({"summary": "ok", "notes_markdown": "ok", "todos": "not-an-array",
               "calendar_suggestions": [None, 5, {"title": ""}, {"title": "T"}]})  # fmt: skip
    assert a.todos == []
    assert [c.title for c in a.calendar] == ["T"]
    assert a.calendar[0].proposed_at is None and a.calendar[0].raw_mention == ""


def test_nulls_and_bad_values_become_none() -> None:
    a = parse({**GOOD, "todos": [
        {"content": "Do X", "assignee": None, "due_date": None, "source_segment_index": None},
        {"content": "Do Y", "assignee": 5, "due_date": "next week", "source_segment_index": 99},
        {"content": "Do Z", "due_date": "2025-02-30", "source_segment_index": True},
        {"content": "", "assignee": "x"},
    ]})  # fmt: skip
    assert [(t.content, t.assignee, t.due_date, t.segment_index) for t in a.todos] == [
        ("Do X", None, None, None), ("Do Y", None, None, None), ("Do Z", None, None, None),
    ]  # fmt: skip


@pytest.mark.parametrize(
    ("value", "expected"),
    [("2025-12-15T10:00:00+07:00", datetime(2025, 12, 15, 3, tzinfo=UTC)),
     ("2025-12-15T10:00:00", datetime(2025, 12, 15, 10, tzinfo=UTC)),
     ("2025-12-15", None), ("tomorrow", None), (12, None)],
)  # fmt: skip
def test_proposed_at(value: Any, expected: datetime | None) -> None:
    a = parse({**GOOD, "calendar_suggestions": [{"title": "T", "proposed_at": value}]})
    assert a.calendar[0].proposed_at == expected


def test_values_are_bounded_and_nul_free() -> None:
    a = parse({
        "summary": "s\x00" + "x" * (LIMITS.summary + 10), "notes_markdown": "n",
        "todos": [{"content": "c" * 5000, "assignee": "a" * 500}] * (LIMITS.items + 5),
        "calendar_suggestions": [],
    })  # fmt: skip
    assert "\x00" not in a.summary and len(a.summary) == LIMITS.summary
    assert len(a.todos) == LIMITS.items
    assert len(a.todos[0].content) == LIMITS.text and len(a.todos[0].assignee or "") == LIMITS.short


# --- generation model ---------------------------------------------------------------------------

GEMINI = ("gemini", "gemini-2.5-flash")
GPT = ("openai", "gpt-4o")
MINI = ("openai", "gpt-4o-mini")
ALL = [GEMINI, GPT, MINI]


def test_parse_pick() -> None:
    assert parse_pick({"provider": "openai", "model": "gpt-4o"}) == GPT
    for bad in (None, {}, {"provider": "openai"}, {"provider": 1, "model": "x"}, "openai:gpt"):
        assert parse_pick(bad) is None


def test_system_default_must_be_registered() -> None:
    assert system_default({"provider": "openai", "model": "gpt-4o"}) == GPT
    assert system_default({"provider": "openai", "model": "gpt-9"}) == GEMINI
    assert system_default(None) == GEMINI


@pytest.mark.parametrize(
    ("allowed", "pref", "pick", "expected"),
    [
        (ALL, None, GPT, GPT),            # explicit pick wins
        (ALL, MINI, GPT, GPT),
        ([GEMINI], MINI, GPT, GEMINI),    # pick and pref not allowed → system default
        (ALL, MINI, None, MINI),          # user default
        (ALL, None, None, GEMINI),
        ([GEMINI, GPT], MINI, None, GEMINI),
        ([], GPT, GPT, GEMINI),           # empty allow-list: system default (safety valve)
        (ALL, None, ("openai", "gpt-9"), GEMINI),  # not registered
    ],
)  # fmt: skip
def test_resolve_generation_model(
    allowed: list[tuple[str, str]], pref: Any, pick: Any, expected: tuple[str, str]
) -> None:
    assert resolve_generation_model(allowed, GEMINI, pref, pick) == expected
