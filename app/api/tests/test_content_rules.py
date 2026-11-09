"""PRO-06: editing summary / notes with a version history. Pure rules."""

import hashlib
import uuid
from typing import Any

import pytest

from app.core.errors import AppError
from app.domain.content import (
    MAX_CONTENT,
    MAX_VERSIONS,
    content_hash,
    edited_by_person,
    parse_content_edit,
    parse_content_field,
    parse_restore,
    version_author,
    versions_to_prune,
    versions_to_write,
)

H = hashlib.sha256(b"old").hexdigest()


def _fails(body: Any) -> tuple[int, str]:
    with pytest.raises(AppError) as exc:
        parse_content_edit(body)
    return exc.value.status, exc.value.code


def test_hash_is_sha256_of_utf8_and_none_is_empty() -> None:
    assert content_hash("old") == H
    assert content_hash(None) == content_hash("") == hashlib.sha256(b"").hexdigest()
    assert content_hash("Họp") == hashlib.sha256("Họp".encode()).hexdigest()


def test_a_valid_edit() -> None:
    edit = parse_content_edit({"field": "notes", "content": "# Notes\n- a", "baseHash": H})
    assert (edit.field, edit.content, edit.base_hash) == ("notes", "# Notes\n- a", H)
    assert parse_content_edit({"field": "summary", "content": "", "baseHash": H}).content == ""


@pytest.mark.parametrize(
    "body",
    [
        {"field": "title", "content": "x", "baseHash": H},
        {"content": "x", "baseHash": H},
        {"field": "notes", "content": 5, "baseHash": H},
        {"field": "notes", "baseHash": H},
        {"field": "notes", "content": "x", "baseHash": "abc"},
        {"field": "notes", "content": "x", "baseHash": H.upper()},
        {"field": "notes", "content": "x"},
    ],
)
def test_bad_edits_are_422(body: Any) -> None:
    assert _fails(body)[0] == 422


def test_length_limits_per_field() -> None:
    assert MAX_CONTENT == {"summary": 20_000, "notes": 200_000}
    from app.services.ai.analysis import LIMITS

    assert (LIMITS.summary, LIMITS.notes) == (MAX_CONTENT["summary"], MAX_CONTENT["notes"])
    parse_content_edit({"field": "summary", "content": "x" * 20_000, "baseHash": H})
    assert _fails({"field": "summary", "content": "x" * 20_001, "baseHash": H})[0] == 422
    assert _fails({"field": "notes", "content": "x" * 200_001, "baseHash": H})[0] == 422


@pytest.mark.parametrize("bad", ["a\x00b", "a\ud800b"])
def test_nul_and_lone_surrogates_are_refused(bad: str) -> None:
    assert _fails({"field": "notes", "content": bad, "baseHash": H}) == (422, "invalid_characters")


def test_newlines_tabs_and_unicode_are_kept() -> None:
    text = "Dòng 1\n\tDòng 2 ❤️"
    assert parse_content_edit({"field": "notes", "content": text, "baseHash": H}).content == text


def test_field_query() -> None:
    assert parse_content_field("summary") == "summary"
    with pytest.raises(AppError) as exc:
        parse_content_field("transcript")
    assert exc.value.status == 422


def test_restore_needs_a_base_hash() -> None:
    assert parse_restore({"baseHash": H}) == H
    with pytest.raises(AppError):
        parse_restore({})


def test_first_edit_keeps_the_ai_text_first() -> None:
    assert versions_to_write(newest=None, current="AI text", new="mine", source="user") == [
        ("AI text", "ai"),
        ("mine", "user"),
    ]


def test_later_edits_write_only_the_new_text() -> None:
    assert versions_to_write(newest="mine", current="mine", new="mine 2", source="user") == [
        ("mine 2", "user")
    ]


def test_text_rewritten_outside_the_history_is_kept_first() -> None:
    # The worker re-processed the meeting (it writes no version): the current text is AI text the
    # newest version does not hold, so it is kept before the edit (security review round 1).
    assert versions_to_write(newest="mine", current="AI again", new="fix", source="user") == [
        ("AI again", "ai"),
        ("fix", "user"),
    ]


def test_empty_or_unchanged_current_text_is_not_kept_twice() -> None:
    assert versions_to_write(newest=None, current=None, new="mine", source="user") == [
        ("mine", "user")
    ]
    assert versions_to_write(newest=None, current="", new="x", source="user") == [("x", "user")]
    assert versions_to_write(newest=None, current="same", new="same", source="ai") == [
        ("same", "ai")
    ]


def test_regenerate_and_restore_sources() -> None:
    assert versions_to_write(newest="a", current="a", new="b", source="ai") == [("b", "ai")]
    assert versions_to_write(newest="a", current="a", new="b", source="restore") == [
        ("b", "restore")
    ]
    with pytest.raises(ValueError):
        versions_to_write(newest="a", current="a", new="b", source="other")


def test_who_wrote_a_version() -> None:
    me = uuid.uuid4()
    assert version_author("user", me) == me
    assert version_author("restore", me) == me
    assert version_author("ai", me) is None  # AI text is never shown as written by a person


def test_edited_by_a_person_only_when_the_newest_version_is_the_current_text() -> None:
    assert edited_by_person("user", newest="x", current="x") is True
    assert edited_by_person("restore", newest="x", current="x") is True
    assert edited_by_person("ai", newest="x", current="x") is False
    assert edited_by_person(None, newest=None, current="x") is False
    assert edited_by_person("user", newest="x", current="AI again") is False  # reprocessed since


def test_prune_keeps_the_50_newest() -> None:
    assert MAX_VERSIONS == 50
    ids = [uuid.uuid4() for _ in range(53)]  # newest first
    assert versions_to_prune(ids) == ids[50:]
    assert versions_to_prune(ids[:50]) == []
    assert versions_to_prune([]) == []
