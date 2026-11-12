"""Meeting analysis: prompt, response schema and defensive parse (ARC-08c; port of v1
``lib/gemini/analyze.ts``, ``types/pipeline.ts`` ``GeminiAnalysisSchema`` and
``lib/pipeline/guards.ts``). Pure.

The answer is untrusted model output: wrong types fall back field by field (v1 ``.catch``), bad
items are dropped (not the whole list), dates must parse (``todos.due_date`` is a ``date``), text
is bounded and NUL-free (Postgres rejects NUL). An answer that is not a JSON object or has neither
summary nor notes raises ``ParseFailed`` (one strict retry, then terminal).
"""

import json
import re
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any

from app.services.ai.service import ParseFailed

STRICT_SUFFIX = (
    "\n\nReturn ONLY valid JSON matching the required schema. No markdown fences, no explanation."
)
UNKNOWN_DATE = "MEETING_DATE: (unknown — do not guess or fabricate any dates)"
_FENCE_START = re.compile(r"^```(?:json)?\s*", re.I)
_FENCE_END = re.compile(r"\s*```\s*$")
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


@dataclass(frozen=True)
class Limits:
    summary: int = 20_000
    notes: int = 200_000
    items: int = 200
    text: int = 2_000
    short: int = 200


LIMITS = Limits()


def _nullable(t: str, description: str | None = None) -> dict[str, Any]:
    node: dict[str, Any] = {"type": t, "nullable": True}
    if description:
        node["description"] = description
    return node


ANALYSIS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "summary": {
            "type": "string",
            "description": "A few factual sentences covering the meeting purpose, participants, "
            "and topics discussed — based only on the transcript, no fabrication",
        },
        "notes_markdown": {
            "type": "string",
            "description": "Structured meeting notes in Markdown with section headings (Key "
            "points, Feedback, Notes/Remarks) and bullets — sections present only if the "
            "transcript had content for them; no fabrication",
        },
        "todos": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "content": {"type": "string", "description": "Action item description"},
                    "assignee": _nullable("string"),
                    "due_date": _nullable("string", "YYYY-MM-DD or null"),
                    "source_segment_index": _nullable(
                        "integer", "0-based index into the segments array"
                    ),
                },
                "required": ["content", "assignee", "due_date", "source_segment_index"],
            },
        },
        "calendar_suggestions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "proposed_at": _nullable("string", "ISO 8601 datetime or null if vague"),
                    "raw_mention": {
                        "type": "string",
                        "description": "Exact phrase from the transcript",
                    },
                    "source_segment_index": _nullable(
                        "integer", "0-based index into the segments array"
                    ),
                },
                "required": ["title", "proposed_at", "raw_mention", "source_segment_index"],
            },
        },
    },
    "required": ["summary", "notes_markdown", "todos", "calendar_suggestions"],
}


@dataclass(frozen=True)
class SegmentText:
    speaker: str | None
    start_ms: int
    text: str


@dataclass(frozen=True)
class Todo:
    content: str
    assignee: str | None
    due_date: date | None
    segment_index: int | None


@dataclass(frozen=True)
class CalendarItem:
    title: str
    proposed_at: datetime | None
    raw_mention: str
    segment_index: int | None


@dataclass(frozen=True)
class Analysis:
    summary: str
    notes: str
    todos: list[Todo]
    calendar: list[CalendarItem]


def _seconds(ms: int) -> str:
    """``(ms / 1000).toFixed(1)`` (JS rounds half up)."""
    tenths = (max(ms, 0) + 50) // 100
    return f"{tenths // 10}.{tenths % 10}"


def build_user_content(
    segments: list[SegmentText], *, strict: bool, meeting_date: str | None
) -> str:
    lines = "\n".join(
        f"[{i}] {s.speaker or 'Speaker'} ({_seconds(s.start_ms)}s): {s.text}"
        for i, s in enumerate(segments)
    )
    head = f"MEETING_DATE: {meeting_date}" if meeting_date else UNKNOWN_DATE
    body = f"{head}\n\nTRANSCRIPT (each line prefixed with its 0-based segment index [N]):\n{lines}"
    return body + STRICT_SUFFIX if strict else body


_UNSAFE = re.compile("[\x00\ud800-\udfff]")  # NUL and lone surrogates: Postgres / UTF-8 reject


def _text(value: Any, limit: int) -> str:
    return _UNSAFE.sub("", value)[:limit] if isinstance(value, str) else ""


def _opt_text(value: Any, limit: int) -> str | None:
    text = _text(value, limit).strip()
    return text or None


def _index(value: Any, segments: int) -> int | None:
    ok = isinstance(value, int) and not isinstance(value, bool) and 0 <= value < segments
    return value if ok else None


def _day(value: Any) -> date | None:
    if not isinstance(value, str) or not _DAY.fullmatch(value):
        return None
    try:
        day = date.fromisoformat(value)
    except ValueError:
        return None
    return day if 1970 <= day.year <= 2100 else None


def _instant(value: Any) -> datetime | None:
    """ISO 8601 date-time; no offset = UTC (v1 sent it to a timestamptz column as is)."""
    if not isinstance(value, str) or "T" not in value or len(value) > 40:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if not 1970 <= parsed.year <= 2100:
            return None
        return (parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)).astimezone(UTC)
    except (ValueError, OverflowError):
        return None


def _items(value: Any) -> list[dict[str, Any]]:
    return (
        [v for v in value if isinstance(v, dict)][: LIMITS.items] if isinstance(value, list) else []
    )


def parse_analysis(raw: str, segment_count: int) -> Analysis:
    cleaned = _FENCE_END.sub("", _FENCE_START.sub("", raw.strip())).strip()
    try:
        data = json.loads(cleaned)
    except ValueError:
        raise ParseFailed(f"analysis is not JSON ({len(raw)} chars)") from None  # no content
    if not isinstance(data, dict):
        raise ParseFailed("analysis is not a JSON object")
    # Some models encode newlines as a literal backslash + n (v1).
    summary = _text(data.get("summary"), LIMITS.summary).replace("\\n", "\n")
    notes = _text(data.get("notes_markdown"), LIMITS.notes).replace("\\n", "\n")
    if not summary.strip() and not notes.strip():
        raise ParseFailed("analysis returned empty summary and notes")
    todos = [
        Todo(content, _opt_text(t.get("assignee"), LIMITS.short), _day(t.get("due_date")),
             _index(t.get("source_segment_index"), segment_count))
        for t in _items(data.get("todos"))
        if (content := _text(t.get("content"), LIMITS.text).strip())
    ]  # fmt: skip
    calendar = [
        CalendarItem(title, _instant(c.get("proposed_at")),
                     _text(c.get("raw_mention"), LIMITS.text),
                     _index(c.get("source_segment_index"), segment_count))
        for c in _items(data.get("calendar_suggestions"))
        if (title := _text(c.get("title"), LIMITS.text).strip())
    ]  # fmt: skip
    return Analysis(summary, notes, todos, calendar)
