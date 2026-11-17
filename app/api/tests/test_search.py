"""PRO-05: library-wide search, pure parts (folding, query parsing, excerpts, fusion)."""

import uuid
from pathlib import Path

import pytest

from app.core.errors import BadRequest
from app.domain.search import (
    FOLD_FROM,
    FOLD_TO,
    MAX_TERMS,
    KeywordHit,
    Kind,
    SemanticHit,
    excerpt,
    fold,
    fuse,
    like_term,
    parse_search,
    term_hits,
)

M1, M2, M3 = (uuid.UUID(int=i) for i in (1, 2, 3))
MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "sql" / "0013_search_fold.sql"


# --- fold ------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "folded"),
    [
        ("Ngân sách", "ngan sach"),
        ("NGÂN SÁCH", "ngan sach"),
        ("Đường đi", "duong di"),
        ("Phở bò ỔN ĐỊNH", "pho bo on dinh"),
        ("Crème brûlée, naïve, Ñandú", "creme brulee, naive, nandu"),
        ("Q3 roadmap", "q3 roadmap"),
        ("", ""),
    ],
)
def test_fold_strips_accents_and_case(raw: str, folded: str) -> None:
    assert fold(raw) == folded


def test_fold_composes_first() -> None:
    assert fold("Ngân sách") == "ngan sach"  # decomposed input (NFD)


def test_fold_keeps_the_length_so_ranges_map_back() -> None:
    for text in ("Ngân sách Q3", "İstanbul", "ẞtraße", "日本語 テスト"):
        assert len(fold(text)) == len(text)


def test_the_migration_uses_the_same_table() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")
    assert f"'{FOLD_FROM}'" in sql and f"'{FOLD_TO}'" in sql
    assert len(FOLD_FROM) == len(FOLD_TO)
    assert all(ord(c) < 128 for c in FOLD_TO)
    assert "'" not in FOLD_FROM


# --- parse -----------------------------------------------------------------------------------------


def test_parse_terms() -> None:
    q = parse_search({"q": "  Ngân   sách ngân Q3 "})
    assert q.text == "Ngân sách ngân Q3"
    assert q.terms == ("ngan", "sach", "q3")
    assert q.folder_id is None


def test_parse_folder() -> None:
    fid = uuid.uuid4()
    assert parse_search({"q": "ab", "folderId": str(fid)}).folder_id == fid
    assert parse_search({"q": "ab", "folderId": ""}).folder_id is None


def test_one_character_terms_are_dropped() -> None:
    assert parse_search({"q": "a ngân b"}).terms == ("ngan",)
    with pytest.raises(BadRequest):
        parse_search({"q": "a b c"})  # nothing left to search for


def test_at_most_eight_terms() -> None:
    q = parse_search({"q": " ".join(f"w{i}" for i in range(12))})
    assert len(q.terms) == MAX_TERMS == 8


@pytest.mark.parametrize(
    "query",
    [
        {},
        {"q": ""},
        {"q": " a "},
        {"q": "x" * 201},
        {"q": "\x00\x00"},
        {"q": "ab", "folderId": "nope"},
    ],
)
def test_bad_queries_are_400(query: dict[str, str]) -> None:
    with pytest.raises(BadRequest):
        parse_search(query)


def test_like_term_escapes_wildcards() -> None:
    assert like_term("50%_a\\b") == "%50\\%\\_a\\\\b%"


def test_term_hits_counts_every_occurrence() -> None:
    assert term_hits("Ngân sách, ngân hàng và NGÂN sách", ("ngan", "sach")) == 5
    assert term_hits("nothing here", ("ngan",)) == 0


# --- excerpt ---------------------------------------------------------------------------------------


def test_a_short_text_is_kept_whole_with_its_matches() -> None:
    text, ranges = excerpt("Chốt ngân sách Q3 hôm nay", ("ngan", "q3"))
    assert text == "Chốt ngân sách Q3 hôm nay"
    assert [text[a:b] for a, b in ranges] == ["ngân", "Q3"]


def test_a_long_text_is_cut_around_the_first_match() -> None:
    body = "lorem " * 100 + "Chốt NGÂN SÁCH quý ba " + "ipsum " * 100
    text, ranges = excerpt(body, ("ngan", "sach"), width=80)
    assert text.startswith("…") and text.endswith("…")
    assert len(text) <= 82
    assert [text[a:b] for a, b in ranges] == ["NGÂN", "SÁCH"]


def test_no_match_gives_the_start() -> None:
    text, ranges = excerpt("a " * 200, ("zzz",), width=40)
    assert text.startswith("a a") and text.endswith("…") and ranges == []


def test_ranges_count_utf16_units_like_the_browser() -> None:
    text, ranges = excerpt("🎉 Ngân sách", ("ngan",))
    assert ranges == [(3, 7)]  # the emoji is 2 UTF-16 units (1 code point)
    assert text.encode("utf-16-le")[6:14].decode("utf-16-le") == "Ngân"


def test_overlapping_matches_merge() -> None:
    text, ranges = excerpt("abcdef", ("abc", "bcd"))
    assert ranges == [(0, 4)]


# --- fuse ------------------------------------------------------------------------------------------


def _kw(
    meeting: uuid.UUID,
    kind: Kind = "transcript",
    start: int | None = 0,
    *,
    end: int | None = None,
    text: str = "ngân sách",
    score: int = 1,
) -> KeywordHit:
    return KeywordHit(meeting, kind, start, start if end is None else end, text, score)


def _sem(meeting: uuid.UUID, start: int, end: int, sim: float = 0.8) -> SemanticHit:
    return SemanticHit(meeting, start, end, "chi phí quý ba", sim)


def test_groups_by_meeting_best_first() -> None:
    groups = fuse([_kw(M1, score=1), _kw(M2, score=5)], [], ("ngan",))
    assert [g.meeting_id for g in groups] == [M2, M1]
    assert groups[0].items[0].source == "keyword"


def test_a_semantic_chunk_covering_a_keyword_segment_merges() -> None:
    groups = fuse([_kw(M1, start=5_000, end=6_000)], [_sem(M1, 0, 30_000)], ("ngan",))
    [group] = groups
    [item] = group.items
    assert (item.source, item.start_ms) == ("both", 5_000)


def test_a_segment_overlapping_the_chunk_start_merges_and_every_covered_hit_gains() -> None:
    hits = [_kw(M1, start=9_000, end=12_000), _kw(M1, start=20_000, end=21_000, score=2)]
    [group] = fuse(hits, [_sem(M1, 10_000, 30_000)], ("ngan",))
    assert sorted((i.start_ms, i.source) for i in group.items) == [
        (9_000, "both"),
        (20_000, "both"),
    ]


def test_equal_scores_keep_the_given_order() -> None:
    # the router passes hits newest meeting first: a tie must not reorder them
    groups = fuse([_kw(M2, "summary", None), _kw(M1), _kw(M3, "notes", None)], [], ("ngan",))
    assert [g.meeting_id for g in groups] == [M2, M1, M3]


def test_semantic_only_results_are_kept() -> None:
    groups = fuse([], [_sem(M3, 60_000, 90_000)], ("budget",))
    [item] = groups[0].items
    assert (item.kind, item.source, item.start_ms, item.ranges) == (
        "transcript",
        "semantic",
        60_000,
        [],
    )


def test_agreement_ranks_above_a_single_list() -> None:
    groups = fuse([_kw(M1, score=9), _kw(M2, start=1000, score=8)], [_sem(M2, 0, 5000)], ("ngan",))
    assert groups[0].meeting_id == M2


def test_summary_and_notes_hits_have_no_time() -> None:
    groups = fuse([_kw(M1, "summary", None), _kw(M1, "notes", None, score=3)], [], ("ngan",))
    assert [(i.kind, i.start_ms) for i in groups[0].items] == [("notes", None), ("summary", None)]


def test_limits() -> None:
    hits = [_kw(uuid.UUID(int=100 + m), start=s, score=1) for m in range(30) for s in range(8)]
    groups = fuse(hits, [], ("ngan",), max_meetings=20, per_meeting=5)
    assert len(groups) == 20 and all(len(g.items) == 5 for g in groups)


def test_items_carry_an_excerpt() -> None:
    [group] = fuse([_kw(M1, text="Họp về Ngân sách")], [], ("ngan",))
    item = group.items[0]
    assert [item.text[a:b] for a, b in item.ranges] == ["Ngân"]
