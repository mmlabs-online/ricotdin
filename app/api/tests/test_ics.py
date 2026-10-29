"""ARC-07: RFC 5545 builder, ported from legacy/tests/ics.test.ts (same cases)."""

from datetime import UTC, datetime, timedelta, timezone

import pytest

from app.domain.ics import (
    DEFAULT_DURATION_MINUTES,
    IcsError,
    build_ics,
    build_suggestion_ics,
    escape_ics_text,
    fold_ics_line,
    format_ics_date,
    ics_filename,
)

START = datetime(2026, 3, 5, 9, 7, 3, tzinfo=UTC)
STAMP = datetime(2026, 3, 1, 12, 0, 0, tzinfo=UTC)


def _unfold(text: str) -> str:
    return text.replace("\r\n ", "")


# --- escape_ics_text --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "want"),
    [
        ("a, b", "a\\, b"),
        ("a; b", "a\\; b"),
        ("a\\b", "a\\\\b"),
        ("a\nb", "a\\nb"),
        ("a\r\nb", "a\\nb"),
        ("a\rb", "a\\nb"),
        ("10:30", "10:30"),
        ('say "hi"', 'say "hi"'),
        ("", ""),
    ],
)
def test_escape_ics_text(raw: str, want: str) -> None:
    assert escape_ics_text(raw) == want


# --- fold_ics_line ----------------------------------------------------------------------------


def test_fold_short_line_unchanged() -> None:
    assert fold_ics_line("SUMMARY:hi") == "SUMMARY:hi"


def test_fold_exactly_75_unchanged() -> None:
    line = "X" * 75
    assert fold_ics_line(line) == line


def test_fold_long_line() -> None:
    line = "SUMMARY:" + "a" * 200
    folded = fold_ics_line(line)
    assert "\r\n " in folded
    parts = folded.split("\r\n")
    assert all(len(p) <= 75 for p in parts)
    assert _unfold(folded) == line


# --- format_ics_date --------------------------------------------------------------------------


def test_format_ics_date_utc_and_padding() -> None:
    assert format_ics_date(START) == "20260305T090703Z"


def test_format_ics_date_converts_other_zones_to_utc() -> None:
    hanoi = timezone(timedelta(hours=7))
    assert format_ics_date(datetime(2026, 3, 5, 16, 7, 3, tzinfo=hanoi)) == "20260305T090703Z"


# --- build_ics --------------------------------------------------------------------------------


def _ics(**kw: object) -> str:
    args: dict[str, object] = {
        "uid": "abc@ricotdin",
        "summary": "Plan, review; ship",
        "dtstart": START,
        "dtstamp": STAMP,
    }
    args.update(kw)
    return build_ics(**args)  # type: ignore[arg-type]


def test_build_ics_structure_and_crlf() -> None:
    text = _ics()
    lines = text.split("\r\n")
    assert lines[:6] == [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Ricotdin//Meeting Assistant//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
    ]
    assert "END:VEVENT" in lines and "END:VCALENDAR" in lines
    assert text.endswith("\r\n")
    assert "\n" not in text.replace("\r\n", "")


def test_build_ics_fields() -> None:
    text = _ics()
    assert "DTSTART:20260305T090703Z" in text
    assert "DTSTAMP:20260301T120000Z" in text
    assert "SUMMARY:Plan\\, review\\; ship" in text
    assert "UID:abc@ricotdin" in text
    assert f"DURATION:PT{DEFAULT_DURATION_MINUTES}M" in text
    assert "DESCRIPTION" not in text


def test_build_ics_custom_duration_and_description() -> None:
    text = _ics(duration_minutes=30, description="Line 1\nLine 2")
    assert "DURATION:PT30M" in text
    assert "DESCRIPTION:Line 1\\nLine 2" in text


# --- build_suggestion_ics ---------------------------------------------------------------------


def _row(**kw: object) -> dict[str, object]:
    row: dict[str, object] = {
        "id": "11111111-2222-3333-4444-555555555555",
        "title": "Sprint review",
        "proposed_at": START,
        "raw_mention": "next Thursday at 9",
    }
    row.update(kw)
    return row


def test_build_suggestion_ics() -> None:
    text = _unfold(build_suggestion_ics(_row(), STAMP))
    assert "UID:11111111-2222-3333-4444-555555555555@ricotdin" in text
    assert "DTSTART:20260305T090703Z" in text
    assert 'Mentioned in meeting: "next Thursday at 9"' in text
    assert "Auto-detected from meeting transcript." in text


def test_build_suggestion_ics_accepts_iso_string() -> None:
    text = build_suggestion_ics(_row(proposed_at="2026-03-05T09:07:03+00:00"), STAMP)
    assert "DTSTART:20260305T090703Z" in text


def test_build_suggestion_ics_without_raw_mention() -> None:
    text = _unfold(build_suggestion_ics(_row(raw_mention=None), STAMP))
    assert "Mentioned in meeting" not in text
    assert "DESCRIPTION:Auto-detected from meeting transcript." in text


def test_build_suggestion_ics_requires_proposed_at() -> None:
    with pytest.raises(IcsError, match="has no proposed_at"):
        build_suggestion_ics(_row(proposed_at=None), STAMP)


def test_build_suggestion_ics_rejects_invalid_date() -> None:
    with pytest.raises(IcsError, match="invalid proposed_at"):
        build_suggestion_ics(_row(proposed_at="not a date"), STAMP)


# --- ics_filename (route: Content-Disposition) ------------------------------------------------


@pytest.mark.parametrize(
    ("title", "want"),
    [
        ("Sprint Review #3", "sprint-review-3.ics"),
        ("  --Hello__World--  ", "hello-world.ics"),
        ("Họp nhóm", "h-p-nh-m.ics"),
        ("日本語", "event.ics"),
        ("", "event.ics"),
        ("a" * 80, "a" * 60 + ".ics"),
        ("İstanbul ſ K", "stanbul-k.ics"),  # non-ASCII letters that IGNORECASE would let through
    ],
)
def test_ics_filename(title: str, want: str) -> None:
    assert ics_filename(title) == want
