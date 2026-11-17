"""Library-wide search (PRO-05). Pure: accent folding, query parsing, excerpts and the fusion of
keyword and semantic hits.

``fold`` must equal SQL ``public.ricotdin_fold`` (migration ``0013_search_fold``), which uses the
same ``translate`` table (``FOLD_FROM`` / ``FOLD_TO``; a test checks the migration text). Folding
keeps the length of NFC text, so match positions in the folded text are positions in the text.
"""

import re
import string
import unicodedata
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from app.core.errors import BadRequest


def _fold_table() -> tuple[str, str]:
    src, dst = [], []
    for cp in [*range(0xC0, 0x250), *range(0x1E00, 0x1F00)]:
        ch = chr(cp)
        parts = unicodedata.normalize("NFD", ch)
        base = parts[0]
        if (
            len(parts) > 1
            and base in string.ascii_letters
            and all(unicodedata.combining(c) for c in parts[1:])
        ):
            src.append(ch)
            dst.append(base)
    src += ["đ", "Đ"]
    dst += ["d", "D"]
    return "".join(src), "".join(dst)


FOLD_FROM, FOLD_TO = _fold_table()
_TABLE = str.maketrans(FOLD_FROM, FOLD_TO)

MIN_QUERY_CHARS = 2
MAX_QUERY_CHARS = 200
MAX_TERMS = 8
EXCERPT_CHARS = 240
RRF_K = 60
_UNSAFE = re.compile("[\x00\ud800-\udfff]")
_EDGE_PUNCT = string.punctuation + "“”‘’«»…–—"

Kind = Literal["transcript", "summary", "notes"]
Source = Literal["keyword", "semantic", "both"]


def fold(text: str) -> str:
    """Accent- and case-insensitive form: NFC, Vietnamese / Latin accents dropped, lower case.
    One character per character (a lower case that would grow keeps the original)."""
    out = unicodedata.normalize("NFC", text).translate(_TABLE)
    return "".join(c.lower() if len(c.lower()) == 1 else c for c in out)


@dataclass(frozen=True)
class SearchQuery:
    text: str
    terms: tuple[str, ...]
    folder_id: uuid.UUID | None


def parse_search(query: Mapping[str, Any]) -> SearchQuery:
    raw = _UNSAFE.sub("", str(query.get("q") or ""))
    text = " ".join(raw.split())
    if not MIN_QUERY_CHARS <= len(text) <= MAX_QUERY_CHARS:
        raise BadRequest(
            f"Type {MIN_QUERY_CHARS} to {MAX_QUERY_CHARS} characters to search.",
        )
    words = (fold(w).strip(_EDGE_PUNCT) for w in text.split())
    terms = tuple(dict.fromkeys(w for w in words if w))[:MAX_TERMS]
    if not terms:
        raise BadRequest("Type a word to search.")
    folder_raw = str(query.get("folderId") or "").strip()
    try:
        folder = uuid.UUID(folder_raw) if folder_raw else None
    except ValueError:
        raise BadRequest("folderId must be a folder id.") from None
    return SearchQuery(text, terms, folder)


def like_term(term: str) -> str:
    """A ``LIKE … ESCAPE '\\'`` pattern finding ``term`` anywhere, wildcards taken literally."""
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _occurrences(folded: str, term: str) -> list[tuple[int, int]]:
    out, at = [], folded.find(term)
    while at != -1:
        out.append((at, at + len(term)))
        at = folded.find(term, at + len(term))
    return out


def term_hits(text: str, terms: Sequence[str]) -> int:
    folded = fold(text)
    return sum(len(_occurrences(folded, t)) for t in terms)


def _merge(ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for a, b in sorted(ranges):
        if out and a <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def excerpt(
    text: str, terms: Sequence[str], width: int = EXCERPT_CHARS
) -> tuple[str, list[tuple[int, int]]]:
    """A window of ``text`` around the first match (``…`` where cut) and the match ranges in it."""
    body = unicodedata.normalize("NFC", text)
    folded = fold(body)
    matches = _merge([r for t in terms for r in _occurrences(folded, t)])
    start, end = 0, len(body)
    if len(body) > width:
        first = matches[0][0] if matches else 0
        start = max(0, first - width // 3)
        end = min(len(body), start + width)
        start = max(0, end - width)
    lead = "…" if start > 0 else ""
    shift = len(lead) - start
    ranges = [(a + shift, b + shift) for a, b in matches if a >= start and b <= end]
    return lead + body[start:end] + ("…" if end < len(body) else ""), ranges


@dataclass(frozen=True)
class KeywordHit:
    meeting_id: uuid.UUID
    kind: Kind
    start_ms: int | None
    end_ms: int | None
    text: str
    score: int  # term occurrences


@dataclass(frozen=True)
class SemanticHit:
    meeting_id: uuid.UUID
    start_ms: int
    end_ms: int
    text: str
    similarity: float


@dataclass
class ResultItem:
    kind: Kind
    start_ms: int | None
    text: str
    ranges: list[tuple[int, int]]
    source: Source
    score: float


@dataclass
class ResultGroup:
    meeting_id: uuid.UUID
    score: float
    items: list[ResultItem] = field(default_factory=list)


def fuse(
    keyword: Sequence[KeywordHit],
    semantic: Sequence[SemanticHit],
    terms: Sequence[str],
    *,
    max_meetings: int = 20,
    per_meeting: int = 5,
) -> list[ResultGroup]:
    """Reciprocal-rank fusion of both lists, grouped by meeting (best first). A semantic chunk
    whose time range holds a keyword transcript hit of the same meeting adds to that hit."""
    items: dict[tuple[uuid.UUID, str, int | None], tuple[uuid.UUID, ResultItem]] = {}
    ranked_kw = sorted(keyword, key=lambda h: -h.score)
    for rank, h in enumerate(ranked_kw):
        key = (h.meeting_id, h.kind, h.start_ms)
        if key in items:
            continue
        text, ranges = excerpt(h.text, terms)
        items[key] = (h.meeting_id, ResultItem(h.kind, h.start_ms, text, ranges, "keyword",
                                               1 / (RRF_K + rank + 1)))  # fmt: skip
    for rank, s in enumerate(sorted(semantic, key=lambda h: -h.similarity)):
        gain = 1 / (RRF_K + rank + 1)
        covered = next(
            (it for (mid, kind, at), (_, it) in items.items()
             if mid == s.meeting_id and kind == "transcript" and it.source == "keyword"
             and at is not None and s.start_ms <= at <= s.end_ms),
            None,
        )  # fmt: skip
        if covered is not None:
            covered.source, covered.score = "both", covered.score + gain
            continue
        key = (s.meeting_id, "transcript", s.start_ms)
        if key not in items:
            text, ranges = excerpt(s.text, terms)
            items[key] = (s.meeting_id, ResultItem("transcript", s.start_ms, text, ranges,
                                                   "semantic", gain))  # fmt: skip
    groups: dict[uuid.UUID, ResultGroup] = {}
    for mid, item in items.values():
        group = groups.setdefault(mid, ResultGroup(mid, 0.0))
        group.items.append(item)
        group.score = max(group.score, item.score)
    ordered = sorted(groups.values(), key=lambda g: -g.score)[:max_meetings]
    for g in ordered:
        g.items = sorted(g.items, key=lambda i: -i.score)[:per_meeting]
    return ordered
