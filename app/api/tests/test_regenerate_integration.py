# ruff: noqa: F811 - pytest fixtures imported from the storage route tests are parameters here
"""ARC-08c: ``POST /meetings/{id}/regenerate`` end to end (scratch database, the real API with a
fake AI provider): owner only, 409 while processing, 422 without a transcript, overwrite summary +
notes with the locked model, AI errors mapped, usage logged as the service role, rate limit."""

import json
import uuid
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient

from app.services.ai.service import AIService
from app.services.keys.pool import KeyWithMeta
from tests.conftest import requires_db
from tests.test_meetings_storage_integration import (  # noqa: F401 - fixtures
    _as,
    _msg,
    _sql,
    client,
    drive,
    world,
)

pytestmark = requires_db

ANSWER = {"summary": "New summary.", "notes_markdown": "## New notes", "todos": [],
          "calendar_suggestions": []}  # fmt: skip


class FakeAI(AIService):
    async def _load_keys(self, db: Any, group: str, provider: str) -> list[KeyWithMeta]:
        return [KeyWithMeta(None, "test-key")]


def install_ai(client: TestClient, answers: list[httpx2.Response]) -> list[httpx2.Request]:
    seen: list[httpx2.Request] = []

    def handle(request: httpx2.Request) -> httpx2.Response:
        request.read()
        seen.append(request)
        return answers.pop(0) if len(answers) > 1 else answers[0]

    async def no_sleep(_s: float) -> None:
        return None

    app: Any = client.app
    app.state.ai = FakeAI(app.state.platform.keys, transport=httpx2.MockTransport(handle),
                          sleep=no_sleep)  # fmt: skip
    app.state.regenerate_limiter = __import__(
        "app.routers.meetings", fromlist=["regenerate_limiter"]
    ).regenerate_limiter()
    return seen


def openai(body: Any) -> httpx2.Response:
    return httpx2.Response(200, json={"choices": [{"message": {"content": json.dumps(body)}}],
                                      "usage": {"total_tokens": 9}})  # fmt: skip


def _meeting(world: dict[str, Any], owner: str, status: str = "done", segments: bool = True,
             folder: bool = False) -> uuid.UUID:  # fmt: skip
    mid = _sql(
        world["db"],
        "INSERT INTO meetings (user_id, status, summary, notes, generation_provider, "
        "generation_model, folder_id) VALUES (%s, %s, 'old', 'old', 'openai', 'gpt-4o', %s) "
        "RETURNING id",
        world[owner], status, world["f"] if folder else None,
    )[0][0]  # fmt: skip
    _sql(world["db"], "INSERT INTO quota_wallets (user_id, audio_seconds_remaining) VALUES (%s, "
         "1000) ON CONFLICT (user_id) DO UPDATE SET audio_seconds_remaining = 1000",
         world[owner])  # fmt: skip
    if segments:
        _sql(world["db"], "INSERT INTO transcript_segments (meeting_id, segment_index, speaker, "
             "start_ms, end_ms, text) VALUES (%s, 0, 'Speaker 1', 0, 900, 'hello')", mid)  # fmt: skip
        _sql(world["db"], "INSERT INTO transcript_chunks (meeting_id, chunk_index, content, "
             "embedding) VALUES (%s, 0, 'hello', array_fill(0, ARRAY[768])::vector)", mid)  # fmt: skip
    return mid  # type: ignore[no-any-return]


def _post(client: TestClient, who: str, mid: Any) -> Any:
    return client.post(f"/meetings/{mid}/regenerate", headers=_as(client, who))


def test_regenerate_overwrites_summary_and_notes_with_the_locked_model(
    client: TestClient, world: dict[str, Any]
) -> None:
    seen = install_ai(client, [openai(ANSWER)])
    mid = _meeting(world, "a", status="failed")
    resp = _post(client, "a", mid)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True, "summary": "New summary.", "notes": "## New notes"}
    assert _sql(world["db"], "SELECT summary, notes, status, error_message FROM meetings "
                "WHERE id = %s", mid) == [("New summary.", "## New notes", "done", None)]  # fmt: skip
    assert seen[0].url.host == "api.openai.com"
    assert json.loads(seen[0].content)["model"] == "gpt-4o"
    usage = _sql(world["db"], "SELECT provider, model, unit, quantity::int, user_id FROM "
                 "usage_log WHERE meeting_id = %s", mid)  # fmt: skip
    assert usage == [("openai", "gpt-4o", "tokens", 9, world["a"])]


@pytest.mark.parametrize(("who", "status"), [("b", 403), ("c", 403), ("d", 403)])  # v1: write
def test_owner_only(client: TestClient, world: dict[str, Any], who: str, status: int) -> None:
    install_ai(client, [openai(ANSWER)])
    mid = _meeting(world, "a", folder=True)
    assert _post(client, who, mid).status_code == status
    assert _sql(world["db"], "SELECT summary FROM meetings WHERE id = %s", mid) == [("old",)]


@pytest.mark.parametrize("status", ["pending", "processing"])
def test_busy_meeting_is_409(client: TestClient, world: dict[str, Any], status: str) -> None:
    seen = install_ai(client, [openai(ANSWER)])
    resp = _post(client, "a", _meeting(world, "a", status=status))
    assert resp.status_code == 409 and _msg(resp) == "This meeting is still being processed."
    assert seen == []


def test_without_transcript_is_422(client: TestClient, world: dict[str, Any]) -> None:
    install_ai(client, [openai(ANSWER)])
    resp = _post(client, "a", _meeting(world, "a", segments=False))
    assert resp.status_code == 422 and _msg(resp) == "No transcript available to analyze."
    assert _post(client, "a", "not-a-uuid").status_code == 404


@pytest.mark.parametrize(
    ("answer", "status"),
    [
        (httpx2.Response(200, json={"choices": [{"message": {"content": "nope"}}]}), 502),
        (httpx2.Response(400, json={"error": {"code": "bad_request"}}), 422),
        (httpx2.Response(503, json={}), 503),
    ],
)
def test_ai_errors_keep_the_old_results(
    client: TestClient, world: dict[str, Any], answer: httpx2.Response, status: int
) -> None:
    install_ai(client, [answer])
    mid = _meeting(world, "a")
    resp = _post(client, "a", mid)
    assert resp.status_code == status
    assert "test-key" not in resp.text
    assert _sql(world["db"], "SELECT summary FROM meetings WHERE id = %s", mid) == [("old",)]


def test_rate_limited(client: TestClient, world: dict[str, Any]) -> None:
    install_ai(client, [openai(ANSWER)])
    mid = _meeting(world, "d")
    codes = [_post(client, "d", mid).status_code for _ in range(11)]
    assert codes[:10] == [200] * 10 and codes[10] == 429


def test_a_queued_reprocess_is_never_ended_by_regenerate(
    client: TestClient, world: dict[str, Any]
) -> None:
    seen = install_ai(client, [openai(ANSWER)])
    mid = _meeting(world, "a", status="failed")
    _sql(world["db"], "INSERT INTO jobs (meeting_id, step, status) VALUES (%s, 'start', 'queued')",
         mid)  # fmt: skip
    resp = _post(client, "a", mid)
    assert resp.status_code == 409 and seen == []
    assert _sql(world["db"], "SELECT status FROM meetings WHERE id = %s", mid) == [("failed",)]


def _ledger(world: dict[str, Any], mid: Any) -> list[tuple[str, str, int]]:
    rows = _sql(world["db"], "SELECT reason, dedup_key, delta_audio_seconds FROM quota_ledger "
                "WHERE meeting_id = %s OR metadata->>'meeting_id' = %s ORDER BY created_at",
                mid, str(mid))  # fmt: skip
    return [(r[0], r[1].rsplit(":", 1)[-1], int(r[2])) for r in rows]


def _wallet(world: dict[str, Any], who: str) -> int:
    return int(_sql(world["db"], "SELECT audio_seconds_remaining FROM quota_wallets "
                    "WHERE user_id = %s", world[who])[0][0])  # fmt: skip


def test_regenerate_is_charged_like_one_generation(
    client: TestClient, world: dict[str, Any]
) -> None:
    install_ai(client, [openai(ANSWER)])
    mid = _meeting(world, "a")
    _sql(world["db"], "INSERT INTO transcript_segments (meeting_id, segment_index, start_ms, "
         "end_ms, text) VALUES (%s, 1, 900, 61500, 'more')", mid)  # fmt: skip
    assert _post(client, "a", mid).status_code == 200
    assert _ledger(world, mid) == [("generate", "charge", -62)]  # ceil(61.5 s)
    assert _wallet(world, "a") == 1000 - 62


def test_insufficient_balance_is_402_without_an_ai_call(
    client: TestClient, world: dict[str, Any]
) -> None:
    seen = install_ai(client, [openai(ANSWER)])
    mid = _meeting(world, "a")
    _sql(world["db"], "UPDATE quota_wallets SET audio_seconds_remaining = 0 WHERE user_id = %s",
         world["a"])  # fmt: skip
    resp = _post(client, "a", mid)
    assert resp.status_code == 402
    assert _msg(resp) == "QUOTA_BLOCKED: Insufficient audio balance. Required: 1s, remaining: 0s."
    assert seen == [] and _ledger(world, mid) == []


def test_a_failed_regenerate_is_refunded(client: TestClient, world: dict[str, Any]) -> None:
    install_ai(client, [httpx2.Response(503, json={})])
    mid = _meeting(world, "a")
    assert _post(client, "a", mid).status_code == 503
    assert _ledger(world, mid) == [("generate", "charge", -1), ("refund", "refund", 1)]
    assert _wallet(world, "a") == 1000


def test_refusals_before_the_charge_cost_nothing(client: TestClient, world: dict[str, Any]) -> None:
    install_ai(client, [openai(ANSWER)])
    busy = _meeting(world, "a", status="processing")
    empty = _meeting(world, "a", segments=False)
    assert _post(client, "a", busy).status_code == 409
    assert _post(client, "a", empty).status_code == 422
    assert _ledger(world, busy) == [] and _ledger(world, empty) == []


def test_deleting_the_meeting_during_the_ai_call_still_refunds(
    client: TestClient, world: dict[str, Any]
) -> None:
    mid = _meeting(world, "a")

    def delete_then_answer(request: httpx2.Request) -> httpx2.Response:
        _sql(world["db"], "DELETE FROM meetings WHERE id = %s", mid)
        return openai(ANSWER)

    app: Any = client.app
    install_ai(client, [openai(ANSWER)])
    app.state.ai = FakeAI(app.state.platform.keys,
                          transport=httpx2.MockTransport(delete_then_answer))  # fmt: skip
    assert _post(client, "a", mid).status_code == 404
    assert _wallet(world, "a") == 1000  # charged 1, refunded 1 (ledger row without the meeting)
    refunds = _sql(world["db"], "SELECT delta_audio_seconds, metadata->>'meeting_id' FROM "
                   "quota_ledger WHERE reason = 'refund' AND metadata->>'meeting_id' = %s",
                   str(mid))  # fmt: skip
    assert refunds == [(1, str(mid))]


def test_a_meeting_that_failed_before_embed_is_409_and_free(
    client: TestClient, world: dict[str, Any]
) -> None:
    seen = install_ai(client, [openai(ANSWER)])
    mid = _meeting(world, "a", status="failed")
    _sql(world["db"], "DELETE FROM transcript_chunks WHERE meeting_id = %s", mid)
    resp = _post(client, "a", mid)
    assert resp.status_code == 409
    assert _msg(resp) == "This meeting did not finish processing. Please process it again."
    assert seen == [] and _ledger(world, mid) == []


def test_a_regenerate_already_in_flight_is_409(client: TestClient, world: dict[str, Any]) -> None:
    seen = install_ai(client, [openai(ANSWER)])
    mid = _meeting(world, "a")
    app: Any = client.app
    app.state.regenerating.add(mid)
    try:
        assert _post(client, "a", mid).status_code == 409
    finally:
        app.state.regenerating.discard(mid)
    assert seen == [] and _ledger(world, mid) == []
    assert _post(client, "a", mid).status_code == 200
    assert mid not in app.state.regenerating
