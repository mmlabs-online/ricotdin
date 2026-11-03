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
    if segments:
        _sql(world["db"], "INSERT INTO transcript_segments (meeting_id, segment_index, speaker, "
             "start_ms, end_ms, text) VALUES (%s, 0, 'Speaker 1', 0, 900, 'hello')", mid)  # fmt: skip
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
