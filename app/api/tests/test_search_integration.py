# ruff: noqa: F811 - pytest fixtures imported from the core domain tests are parameters here
"""PRO-05: GET /search end to end (scratch database, the real API, a stand-in embedder): RLS keeps
results to meetings the caller can see; accent- and case-insensitive keywords, every term
required; semantic hits from transcript_chunks; an embedding failure keeps keyword results."""

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.core.ratelimit import RateLimiter
from app.domain.search import fold
from tests.conftest import requires_db
from tests.test_core_domain_integration import (  # noqa: F401 - fixtures
    _as,
    _sql,
    client,
    world,
)

pytestmark = requires_db

VECTOR = [0.0] * 767 + [1.0]
OTHER = [1.0] + [0.0] * 767  # orthogonal: similarity 0, below the floor


class _Embedder:
    def __init__(self) -> None:
        self.fail = False
        self.calls: list[str] = []

    async def embed(self, db: Any, group: str, texts: list[str], **kw: Any) -> list[list[float]]:
        self.calls.append(kw["operation"])
        if self.fail:
            raise RuntimeError("embedding provider down")
        return [VECTOR if "budget" in t else OTHER for t in texts]  # only 'budget' means it


@pytest.fixture(scope="module")
def seeded(client: TestClient, world: dict[str, Any]) -> Iterator[_Embedder]:
    db = world["db"]
    _sql(db, "INSERT INTO transcript_segments (meeting_id, segment_index, speaker, start_ms, "
         "end_ms, text) VALUES (%s, 5, 'S1', 125000, 130000, 'Chốt NGÂN SÁCH quý ba hôm nay'), "
         "(%s, 6, 'S1', 140000, 150000, 'Kế hoạch tuyển dụng cho nhóm')",
         world["m3"], world["m1"])  # fmt: skip
    _sql(db, "UPDATE meetings SET summary = 'Tổng kết: ngân sách marketing tăng' WHERE id = %s",
         world["m2"])  # fmt: skip
    vector = "[" + ",".join(str(v) for v in VECTOR) + "]"
    _sql(db, "INSERT INTO transcript_chunks (meeting_id, chunk_index, content, embedding, "
         "start_ms, end_ms) VALUES (%s, 0, 'Chi phí quý ba vượt dự kiến', %s::vector, 0, 60000)",
         world["m1"], vector)  # fmt: skip
    app: Any = client.app
    original = app.state.ai
    app.state.ai = embedder = _Embedder()
    try:
        yield embedder
    finally:
        app.state.ai = original


def _search(client: TestClient, who: str, **params: Any) -> dict[str, Any]:
    r = client.get("/search", headers=_as(client, who), params=params)
    assert r.status_code == 200, r.text
    body: dict[str, Any] = r.json()
    return body


def _titles(body: dict[str, Any]) -> list[str]:
    return [g["title"] for g in body["groups"]]


def test_needs_a_token_and_a_query(client: TestClient, seeded: _Embedder) -> None:
    assert client.get("/search", params={"q": "ngan"}).status_code == 401
    for q in ("", "a", "x" * 201):
        assert client.get("/search", headers=_as(client, "a"), params={"q": q}).status_code == 400


def test_accent_insensitive_and_only_visible_meetings(
    client: TestClient, world: dict[str, Any], seeded: _Embedder
) -> None:
    body = _search(client, "a", q="ngan sach")
    assert set(_titles(body)) == {"M3 no audio", "M2"}  # A's own M3 + M2 in A's folder
    m3 = next(g for g in body["groups"] if g["title"] == "M3 no audio")
    [item] = m3["items"]
    assert (item["kind"], item["startMs"], item["source"]) == ("transcript", 125000, "keyword")
    assert [item["text"][a:b] for a, b in item["ranges"]] == ["NGÂN", "SÁCH"]
    m2 = next(g for g in body["groups"] if g["title"] == "M2")
    assert m2["items"][0]["kind"] == "summary" and m2["items"][0]["startMs"] is None
    # B (editor of A's folder) sees M2 but never A's private M3; D sees neither
    assert _titles(_search(client, "b", q="NGÂN SÁCH")) == ["M2"]
    assert _search(client, "d", q="ngân sách")["groups"] == []


def test_every_term_is_needed(client: TestClient, seeded: _Embedder) -> None:
    seeded.fail = True  # keyword only
    try:
        assert _search(client, "a", q="ngan zzzqqq")["groups"] == []
        assert _titles(_search(client, "c", q="tuyen dung")) == ["M1"]  # viewer of the folder
    finally:
        seeded.fail = False


def test_semantic_hits_without_shared_words(
    client: TestClient, world: dict[str, Any], seeded: _Embedder
) -> None:
    body = _search(client, "a", q="budget overrun")
    assert body["semanticAvailable"] is True
    [group] = body["groups"]
    assert group["meetingId"] == str(world["m1"])
    assert (group["items"][0]["source"], group["items"][0]["startMs"]) == ("semantic", 0)
    assert "embed-query" in seeded.calls
    assert _search(client, "d", q="budget overrun")["groups"] == []  # RLS on chunks


def test_an_embedding_failure_keeps_keyword_results(client: TestClient, seeded: _Embedder) -> None:
    seeded.fail = True
    try:
        body = _search(client, "a", q="ngan sach")
        assert body["semanticAvailable"] is False
        assert "M3 no audio" in _titles(body)
    finally:
        seeded.fail = False


def test_folder_filter(client: TestClient, world: dict[str, Any], seeded: _Embedder) -> None:
    body = _search(client, "a", q="ngan sach", folderId=str(world["f1"]))
    assert _titles(body) == ["M2"]
    r = client.get("/search", headers=_as(client, "a"), params={"q": "ab", "folderId": "x"})
    assert r.status_code == 400


def test_rate_limited(client: TestClient, seeded: _Embedder) -> None:
    app: Any = client.app
    original = app.state.search_limiter
    app.state.search_limiter = RateLimiter(capacity=1, refill_per_second=0.0001)
    try:
        assert (
            client.get("/search", headers=_as(client, "e"), params={"q": "zz"}).status_code == 200
        )
        r = client.get("/search", headers=_as(client, "e"), params={"q": "zz"})
        assert r.status_code == 429
    finally:
        app.state.search_limiter = original


@pytest.mark.parametrize(
    "value", ["Ngân sách", "ĐƯỜNG Phở", "Crème Brûlée Ñandú", "Ngân", "日本語 İ ẞ", "a_b%c"]
)
def test_sql_fold_equals_python_fold(world: dict[str, Any], value: str) -> None:
    assert _sql(world["db"], "SELECT public.ricotdin_fold(%s)", value) == [(fold(value),)]
