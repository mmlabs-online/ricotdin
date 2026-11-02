"""RFC 5545 calendar file for a calendar suggestion (ARC-07; port of legacy lib/ics). Pure.

One VEVENT, UTC times, fixed duration, no TZID. Folding counts characters (v1 behaviour).
"""

import re
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

DEFAULT_DURATION_MINUTES = 60
_CRLF = "\r\n"
_LINE = 75


class IcsError(ValueError):
    """The suggestion cannot be turned into a calendar file."""


def escape_ics_text(value: str) -> str:
    out = value.replace("\\", "\\\\").replace(",", "\\,").replace(";", "\\;")
    return re.sub(r"\r\n|\r|\n", "\\\\n", out)


def fold_ics_line(line: str) -> str:
    if len(line) <= _LINE:
        return line
    parts = [line[:_LINE]]
    rest = line[_LINE:]
    while rest:
        parts.append(" " + rest[: _LINE - 1])
        rest = rest[_LINE - 1 :]
    return _CRLF.join(parts)


def format_ics_date(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def build_ics(
    *,
    uid: str,
    summary: str,
    dtstart: datetime,
    dtstamp: datetime,
    duration_minutes: int = DEFAULT_DURATION_MINUTES,
    description: str | None = None,
) -> str:
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Ricotdin//Meeting Assistant//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        f"UID:{uid}",
        f"DTSTAMP:{format_ics_date(dtstamp)}",
        f"DTSTART:{format_ics_date(dtstart)}",
        f"DURATION:PT{duration_minutes}M",
        f"SUMMARY:{escape_ics_text(summary)}",
    ]
    if description:
        lines.append(f"DESCRIPTION:{escape_ics_text(description)}")
    lines += ["END:VEVENT", "END:VCALENDAR"]
    return _CRLF.join(fold_ics_line(line) for line in lines) + _CRLF


def _as_datetime(value: Any, suggestion_id: str) -> datetime:
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:
        message = f'invalid proposed_at value "{value}" for suggestion {suggestion_id}'
        raise IcsError(f"build_suggestion_ics: {message}") from None


def build_suggestion_ics(suggestion: Mapping[str, Any], dtstamp: datetime) -> str:
    sid = str(suggestion["id"])
    proposed = suggestion.get("proposed_at")
    if proposed is None:
        raise IcsError(
            f"build_suggestion_ics: suggestion {sid} has no proposed_at — cannot generate ICS "
            "without a specific time."
        )
    notes = []
    if suggestion.get("raw_mention"):
        notes.append(f'Mentioned in meeting: "{suggestion["raw_mention"]}"')
    notes.append("Auto-detected from meeting transcript.")
    return build_ics(
        uid=f"{sid}@ricotdin",
        summary=str(suggestion.get("title") or ""),
        dtstart=_as_datetime(proposed, sid),
        dtstamp=dtstamp,
        description="\n".join(notes),
    )


def ics_filename(title: str) -> str:
    """``<slug>.ics`` for Content-Disposition (ASCII letters/digits only, as v1)."""
    slug = re.sub(r"[^A-Za-z0-9]+", "-", title, flags=re.ASCII).strip("-").lower()[:60]
    return f"{slug or 'event'}.ics"
