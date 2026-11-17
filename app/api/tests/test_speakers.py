"""PRO-04: speaker names, pure parts (patch parsing, applying names, suggestions)."""

import pytest

from app.core.errors import BadRequest
from app.domain.rules import InvalidNameCharacters
from app.domain.speakers import (
    MAX_NAME_CHARS,
    apply_name,
    clean_names,
    merge_names,
    parse_speaker_patch,
    rank_suggestions,
    rename_chunk,
)

LABELS = {"Speaker 1", "Speaker 2", "Speaker"}


def test_parse_sets_and_clears() -> None:
    body = {"names": {"Speaker 1": "  Lan  ", "Speaker 2": None}}
    assert parse_speaker_patch(body, LABELS) == {"Speaker 1": "Lan", "Speaker 2": None}


def test_an_empty_name_clears_too() -> None:
    assert parse_speaker_patch({"names": {"Speaker 1": "   "}}, LABELS) == {"Speaker 1": None}


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"names": []},
        {"names": {}},
        {"names": {"Speaker 9": "Lan"}},  # not in this meeting
        {"names": {"Speaker 1": 5}},
        {"names": {"Speaker 1": "x" * (MAX_NAME_CHARS + 1)}},
    ],
)
def test_bad_patches_are_400(body: dict[str, object]) -> None:
    with pytest.raises(BadRequest):
        parse_speaker_patch(body, LABELS)


def test_invisible_characters_are_refused() -> None:
    with pytest.raises(InvalidNameCharacters):
        parse_speaker_patch({"names": {"Speaker 1": "La‮n"}}, LABELS)


def test_merge() -> None:
    current = {"Speaker 1": "Lan", "Speaker 2": "Minh"}
    assert merge_names(current, {"Speaker 1": "Lan Anh", "Speaker 2": None}) == {
        "Speaker 1": "Lan Anh"
    }
    assert current == {"Speaker 1": "Lan", "Speaker 2": "Minh"}  # not mutated


def test_clean_names_keeps_only_text_pairs() -> None:
    raw = {"Speaker 1": "Lan", "Speaker 2": "", "Speaker 3": 7, 4: "x", "Speaker 4": "y" * 99}
    assert clean_names(raw) == {"Speaker 1": "Lan", "Speaker 4": "y" * MAX_NAME_CHARS}
    assert clean_names(None) == {} and clean_names("nope") == {}
    assert clean_names('{"Speaker 1": "Lan"}') == {"Speaker 1": "Lan"}  # jsonb read as text


def test_apply_name() -> None:
    names = {"Speaker 1": "Lan"}
    assert apply_name("Speaker 1", names) == "Lan"
    assert apply_name("Speaker 2", names) == "Speaker 2"
    assert apply_name(None, names) is None


def test_rename_chunk_lines() -> None:
    content = (
        "[Speaker 1] Chào mọi người\n[Speaker 2] Bắt đầu\n[] không rõ\n[Speaker 1] ok [Speaker 2]"
    )
    assert rename_chunk(content, {"Speaker 1": "Lan", "Speaker 2": "Minh"}) == (
        "[Lan] Chào mọi người\n[Minh] Bắt đầu\n[] không rõ\n[Lan] ok [Speaker 2]"
    )
    assert rename_chunk(content, {}) == content


def test_suggestions_most_used_first() -> None:
    maps = [
        {"Speaker 1": "Lan", "Speaker 2": "Minh"},
        {"Speaker 1": "Minh", "Speaker 2": "lan"},
        {"Speaker 3": "An"},
        {"Speaker 1": "Minh"},
    ]
    assert rank_suggestions(maps) == ["Minh", "Lan", "An"]


def test_suggestions_are_capped() -> None:
    maps = [{f"Speaker {i}": f"N{i:03d}"} for i in range(80)]
    assert len(rank_suggestions(maps, limit=50)) == 50
