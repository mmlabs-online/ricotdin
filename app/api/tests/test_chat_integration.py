# ruff: noqa: F811 - pytest fixtures imported from the storage route tests are parameters here
"""ARC-09: ``POST /chat`` and ``GET /chat`` end to end (scratch database, the real API, fake AI
providers). Scope: a chunk of a meeting the caller cannot see never reaches the prompt (RLS +
the scope filter), folder scope searches only the folder's visible meetings, global scope only
the caller's visible meetings. Citations: invented ids dropped, times from the database. Quota:
one agent query per question, 402 when none left, refunded on a retrieval or AI failure on our side (a provider refusal is charged, SEC-05)."""

import json
import re
import uuid
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient

from app.rag.scope import MAX_MESSAGE_CHARS
from app.routers.chat import (
    ANSWER_ERROR_REPLY,
    EMPTY_FOLDER_REPLY,
    NO_CONTEXT_REPLY,
    RETRIEVAL_ERROR_REPLY,
    chat_limiter,
)
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

NEAR = "array_fill(0.25::real, ARRAY[768])::vector"  # same direction as the query: similarity 1
FAR = "(array_fill(1::real, ARRAY[384]) || array_fill(-1::real, ARRAY[384]))::vector"  # 0


class FakeAI(AIService):
    async def _load_keys(self, db: Any, group: str, provider: str) -> list[KeyWithMeta]:
        return [KeyWithMeta(None, "test-key")]


class Provider:
    """Fake Gemini (embeddings + generateContent) and OpenAI chat; records every prompt."""

    def __init__(self) -> None:
        self.answer: Any = None  # None → cite every excerpt
        self.status = 200
        self.embed_status = 200
        self.refuse = False  # Gemini blocks the prompt (safety): ModelRefused
        self.prompts: list[str] = []
        self.models: list[str] = []

    def _answer(self, prompt: str) -> str:
        if self.answer is not None:
            return self.answer if isinstance(self.answer, str) else json.dumps(self.answer)
        ids = re.findall(r'<excerpt chunk_id="([^"]+)"', prompt)
        return json.dumps({"answer": "From the meeting.",
                           "citations": [{"chunk_id": i} for i in ids]})  # fmt: skip

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        request.read()
        body = json.loads(request.content)
        if request.url.path.endswith(":batchEmbedContents"):
            if self.embed_status != 200:
                return httpx2.Response(self.embed_status, json={})
            return httpx2.Response(200, json={"embeddings": [{"values": [0.25] * 768}]})
        if self.status != 200:
            return httpx2.Response(self.status, json={"error": {"code": "bad_request"}})
        if request.url.host == "api.openai.com":
            prompt = body["messages"][-1]["content"]
            self.prompts.append(prompt)
            self.models.append(f"openai:{body['model']}")
            return httpx2.Response(200, json={"choices": [{"message": {
                "content": self._answer(prompt)}}], "usage": {"total_tokens": 5}})  # fmt: skip
        if self.refuse:
            return httpx2.Response(200, json={"promptFeedback": {"blockReason": "SAFETY"}})
        prompt = body["contents"][-1]["parts"][0]["text"]
        self.prompts.append(prompt)
        self.models.append(f"gemini:{request.url.path.split('/')[-1].split(':')[0]}")
        return httpx2.Response(200, json={"candidates": [{"content": {"parts": [
            {"text": self._answer(prompt)}]}}]})  # fmt: skip


@pytest.fixture
def ai(client: TestClient) -> Provider:
    fake = Provider()

    async def no_sleep(_s: float) -> None:
        return None

    app: Any = client.app
    app.state.ai = FakeAI(app.state.platform.keys, transport=httpx2.MockTransport(fake),
                          sleep=no_sleep)  # fmt: skip
    app.state.chat_limiter = chat_limiter()
    return fake


def _queries(world: dict[str, Any], who: str, n: int = 10) -> None:
    _sql(world["db"], "INSERT INTO quota_wallets (user_id, agent_queries_remaining) VALUES "
         "(%s, %s) ON CONFLICT (user_id) DO UPDATE SET agent_queries_remaining = %s",
         world[who], n, n)  # fmt: skip


def _left(world: dict[str, Any], who: str) -> int:
    return int(_sql(world["db"], "SELECT agent_queries_remaining FROM quota_wallets "
                    "WHERE user_id = %s", world[who])[0][0])  # fmt: skip


def _meeting(world: dict[str, Any], owner: str, *, folder: bool = False, text: str = "hello",
             vector: str = NEAR, locked: bool = True) -> uuid.UUID:  # fmt: skip
    mid = _sql(
        world["db"],
        "INSERT INTO meetings (user_id, status, generation_provider, generation_model, folder_id) "
        "VALUES (%s, 'done', %s, %s, %s) RETURNING id",
        world[owner], "openai" if locked else None, "gpt-4o" if locked else None,
        world["f"] if folder else None,
    )[0][0]  # fmt: skip
    _sql(world["db"], "INSERT INTO transcript_chunks (meeting_id, chunk_index, content, start_ms, "  # noqa: S608
         f"end_ms, embedding) VALUES (%s, 0, %s, 61000, 65000, {vector})", mid, text)  # fmt: skip
    return mid  # type: ignore[no-any-return]


def _ask(client: TestClient, who: str, message: str = "What was decided?", **scope: Any) -> Any:
    return client.post("/chat", headers=_as(client, who), json={"message": message, **scope})


def _excerpt_texts(ai: Provider) -> str:
    return ai.prompts[-1] if ai.prompts else ""


# --- single meeting --------------------------------------------------------------------------------


def test_meeting_chat_answers_with_citations_and_keeps_history(
    client: TestClient, world: dict[str, Any], ai: Provider
) -> None:
    _queries(world, "a")
    mid = _meeting(world, "a", text="We ship on Friday.")
    resp = _ask(client, "a", meetingId=str(mid))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    session = body["sessionId"]
    msg = body["message"]
    assert msg["role"] == "assistant" and msg["content"] == "From the meeting."
    chunk_id = _sql(world["db"], "SELECT id FROM transcript_chunks WHERE meeting_id = %s", mid)
    assert msg["citations"] == [{"chunk_id": str(chunk_id[0][0]), "meeting_id": str(mid),
                                 "start_ms": 61000, "end_ms": 65000}]  # fmt: skip
    assert "We ship on Friday." in _excerpt_texts(ai) and ai.models == ["openai:gpt-4o"]
    assert _left(world, "a") == 9
    assert _sql(world["db"], "SELECT reason, delta_agent_queries FROM quota_ledger "
                "WHERE user_id = %s", world["a"]) == [("agent_query", -1)]  # fmt: skip
    usage = _sql(world["db"], "SELECT provider, operation FROM usage_log WHERE user_id = %s "
                 "ORDER BY created_at", world["a"])  # fmt: skip
    assert usage == [("gemini-embedding", "embed-query"), ("openai", "chat")]

    again = _ask(client, "a", "And who owns it?", meetingId=str(mid), sessionId=session)
    assert again.status_code == 200 and again.json()["sessionId"] == session
    assert "User: What was decided?" in ai.prompts[-1]
    assert "Assistant: From the meeting." in ai.prompts[-1]

    history = client.get(f"/chat?meetingId={mid}", headers=_as(client, "a"))
    assert history.status_code == 200
    assert history.json()["sessionId"] == session
    assert [m["role"] for m in history.json()["messages"]] == ["user", "assistant"] * 2
    assert client.get(f"/chat?sessionId={session}", headers=_as(client, "a")).json() == \
        history.json()  # fmt: skip
    activity = _sql(world["db"], "SELECT count(*) FROM activity_log WHERE user_id = %s AND "
                    "event_type = 'chat_message' AND meeting_id = %s", world["a"], mid)  # fmt: skip
    assert activity == [(2,)]


def test_invented_citations_are_dropped(
    client: TestClient, world: dict[str, Any], ai: Provider
) -> None:
    _queries(world, "a")
    mid = _meeting(world, "a")
    ai.answer = {"answer": "Yes.", "citations": [{"chunk_id": str(uuid.uuid4())}]}
    resp = _ask(client, "a", meetingId=str(mid))
    assert resp.status_code == 200 and resp.json()["message"]["citations"] == []


def test_nothing_relevant_is_the_not_found_answer(
    client: TestClient, world: dict[str, Any], ai: Provider
) -> None:
    _queries(world, "a")
    mid = _meeting(world, "a", vector=FAR)
    resp = _ask(client, "a", meetingId=str(mid))
    assert resp.status_code == 200
    assert resp.json()["message"]["content"] == NO_CONTEXT_REPLY and ai.prompts == []
    assert _left(world, "a") == 9  # v1: charged


@pytest.mark.parametrize(("who", "status"), [("b", 200), ("c", 200), ("d", 403)])
def test_meeting_access_matrix(
    client: TestClient, world: dict[str, Any], ai: Provider, who: str, status: int
) -> None:
    _queries(world, who)
    mid = _meeting(world, "a", folder=True)
    assert _ask(client, who, meetingId=str(mid)).status_code == status
    assert client.get(f"/chat?meetingId={mid}", headers=_as(client, who)).status_code == status
    if status == 403:
        assert ai.prompts == [] and _left(world, who) == 10


def test_unknown_ids(client: TestClient, world: dict[str, Any], ai: Provider) -> None:
    _queries(world, "a")
    for scope, status in (({"meetingId": str(uuid.uuid4())}, 404), ({"meetingId": "x"}, 404),
                          ({"folderId": "x"}, 403), ({"folderId": str(uuid.uuid4())}, 403),
                          ({"sessionId": "x"}, 404), ({"sessionId": str(uuid.uuid4())}, 404)):  # fmt: skip
        assert _ask(client, "a", **scope).status_code == status, scope
    assert _left(world, "a") == 10


def test_bad_bodies(client: TestClient, world: dict[str, Any], ai: Provider) -> None:
    h = _as(client, "a")
    assert client.post("/chat", headers=h, content=b"nope").status_code == 400
    assert _msg(client.post("/chat", headers=h, json={})) == "message is required."
    long = client.post("/chat", headers=h, json={"message": "x" * (MAX_MESSAGE_CHARS + 1)})
    assert long.status_code == 400
    both = _ask(client, "a", meetingId=str(uuid.uuid4()), folderId=str(uuid.uuid4()))
    assert both.status_code == 400


def test_a_session_is_only_continued_by_its_owner_in_its_scope(
    client: TestClient, world: dict[str, Any], ai: Provider
) -> None:
    for who in "ab":
        _queries(world, who)
    mid = _meeting(world, "a", folder=True)
    session = _ask(client, "a", meetingId=str(mid)).json()["sessionId"]
    stolen = _ask(client, "b", meetingId=str(mid), sessionId=session)
    assert stolen.status_code == 403
    assert client.get(f"/chat?sessionId={session}", headers=_as(client, "b")).status_code == 404
    moved = _ask(client, "a", sessionId=session)  # the meeting chat reused as a global one
    assert moved.status_code == 400
    count = _sql(world["db"], "SELECT count(*) FROM chat_messages WHERE session_id = %s", session)
    assert count == [(2,)]


# --- folder + global scope --------------------------------------------------------------------------


def test_folder_scope_searches_only_the_folder(
    client: TestClient, world: dict[str, Any], ai: Provider
) -> None:
    _queries(world, "c")
    inside = _meeting(world, "a", folder=True, text="IN-FOLDER")
    _meeting(world, "a", text="A-PRIVATE")  # a's meeting outside the folder
    _meeting(world, "c", text="C-OWN")  # c's own meeting, outside the folder
    resp = _ask(client, "c", folderId=str(world["f"]))
    assert resp.status_code == 200, resp.text
    prompt = _excerpt_texts(ai)
    assert "IN-FOLDER" in prompt and "A-PRIVATE" not in prompt and "C-OWN" not in prompt
    cited = {c["meeting_id"] for c in resp.json()["message"]["citations"]}
    in_folder = {str(r[0]) for r in _sql(world["db"], "SELECT id FROM meetings WHERE "
                                          "folder_id = %s", world["f"])}  # fmt: skip
    assert str(inside) in cited and cited <= in_folder
    assert ai.models == ["gemini:gemini-2.5-flash"]  # cross-meeting: the system default
    history = client.get(f"/chat?folderId={world['f']}", headers=_as(client, "c"))
    assert history.status_code == 200 and len(history.json()["messages"]) == 2
    assert client.get(f"/chat?folderId={world['f']}", headers=_as(client, "d")).status_code == 403


def test_empty_folder_is_answered_without_a_charge(
    client: TestClient, world: dict[str, Any], ai: Provider
) -> None:
    _queries(world, "d")
    empty = _sql(world["db"], "INSERT INTO folders (user_id, name) VALUES (%s, %s) RETURNING id",
                 world["d"], f"empty-{uuid.uuid4().hex[:6]}")[0][0]  # fmt: skip
    resp = _ask(client, "d", folderId=str(empty))
    assert resp.status_code == 200 and resp.json()["message"]["content"] == EMPTY_FOLDER_REPLY
    assert _left(world, "d") == 10 and ai.prompts == []


def test_global_scope_never_reaches_meetings_the_caller_cannot_see(
    client: TestClient, world: dict[str, Any], ai: Provider
) -> None:
    _queries(world, "d")
    _meeting(world, "a", text="SECRET-A")
    _meeting(world, "a", folder=True, text="SHARED-FOLDER")  # d has no share
    _meeting(world, "d", text="D-OWN")
    resp = _ask(client, "d")
    assert resp.status_code == 200
    prompt = _excerpt_texts(ai)
    assert "D-OWN" in prompt and "SECRET" not in prompt and "SHARED-FOLDER" not in prompt
    assert client.get("/chat", headers=_as(client, "d")).json() == {"sessionId": None,
                                                                      "messages": []}  # fmt: skip


# --- quota + failures ------------------------------------------------------------------------------


def test_no_queries_left_is_402(client: TestClient, world: dict[str, Any], ai: Provider) -> None:
    _queries(world, "a", 0)
    mid = _meeting(world, "a")
    resp = _ask(client, "a", meetingId=str(mid))
    assert resp.status_code == 402
    assert resp.json()["error"]["code"] == "insufficient_agent_balance"
    assert resp.json()["error"]["remaining_queries"] == 0
    assert ai.prompts == []


def test_retrieval_failure_is_refunded_and_said_honestly(
    client: TestClient, world: dict[str, Any], ai: Provider
) -> None:
    _queries(world, "a")
    ai.embed_status = 400
    resp = _ask(client, "a", meetingId=str(_meeting(world, "a")))
    assert resp.status_code == 200
    assert resp.json()["message"]["content"] == RETRIEVAL_ERROR_REPLY
    assert _left(world, "a") == 10
    charge, refund = (r[0] for r in _sql(world["db"], "SELECT dedup_key FROM quota_ledger "
                      "WHERE user_id = %s ORDER BY created_at DESC LIMIT 2", world["a"])[::-1])  # fmt: skip
    assert charge.endswith(":charge") and refund == charge.replace(":charge", ":refund")


@pytest.mark.parametrize("answer", ["not json", {"answer": "", "citations": []}])
def test_unusable_or_failed_answers_are_refunded(
    client: TestClient, world: dict[str, Any], ai: Provider, answer: Any
) -> None:
    _queries(world, "a")
    ai.answer = answer
    resp = _ask(client, "a", meetingId=str(_meeting(world, "a")))
    assert resp.status_code == 200
    assert resp.json()["message"]["content"] == ANSWER_ERROR_REPLY  # never the raw model text
    assert _left(world, "a") == 10


def test_sec05_model_refusal_is_charged(
    client: TestClient, world: dict[str, Any], ai: Provider
) -> None:
    _queries(world, "a")
    ai.refuse = True  # the model refuses the question itself (AIRefused)
    resp = _ask(client, "a", meetingId=str(_meeting(world, "a")))
    assert resp.json()["message"]["content"] == ANSWER_ERROR_REPLY and _left(world, "a") == 9
    keys = _sql(world["db"], "SELECT dedup_key FROM quota_ledger WHERE user_id = %s", world["a"])
    assert not any(k[0].endswith(":refund") for k in keys)


def test_provider_rejection_of_the_request_is_refunded(
    client: TestClient, world: dict[str, Any], ai: Provider
) -> None:
    _queries(world, "a")
    ai.status = 400  # e.g. a retired model or a prompt we made too large: our side
    resp = _ask(client, "a", meetingId=str(_meeting(world, "a")))
    assert resp.json()["message"]["content"] == ANSWER_ERROR_REPLY and _left(world, "a") == 10


def test_sec05_provider_outage_is_still_refunded(
    client: TestClient, world: dict[str, Any], ai: Provider
) -> None:
    _queries(world, "a")
    ai.status = 503  # our side: no answer could be produced (AIUnavailable)
    resp = _ask(client, "a", meetingId=str(_meeting(world, "a")))
    assert resp.json()["message"]["content"] == ANSWER_ERROR_REPLY and _left(world, "a") == 10


def test_rate_limit(client: TestClient, world: dict[str, Any], ai: Provider) -> None:
    _queries(world, "b", 100)
    app: Any = client.app
    app.state.chat_limiter = __import__("app.core.ratelimit", fromlist=["RateLimiter"]).RateLimiter(
        capacity=1, refill_per_second=0.0001
    )
    assert _ask(client, "b").status_code == 200
    assert _ask(client, "b").status_code == 429


# --- review follow-ups -----------------------------------------------------------------------------


def test_empty_folder_reply_is_listed_after_the_question(
    client: TestClient, world: dict[str, Any], ai: Provider
) -> None:
    empty = _sql(world["db"], "INSERT INTO folders (user_id, name) VALUES (%s, %s) RETURNING id",
                 world["d"], f"order-{uuid.uuid4().hex[:6]}")[0][0]  # fmt: skip
    session = _ask(client, "d", folderId=str(empty)).json()["sessionId"]
    for _ in range(4):
        r = _ask(client, "d", folderId=str(empty), sessionId=session)
        assert r.status_code == 200 and r.json()["sessionId"] == session
    got = client.get(f"/chat?folderId={empty}", headers=_as(client, "d")).json()["messages"]
    assert [m["role"] for m in got] == ["user", "assistant"] * 5


def test_a_revoked_share_ends_the_old_session(
    client: TestClient, world: dict[str, Any], ai: Provider
) -> None:
    _queries(world, "c")
    folder = _sql(world["db"], "INSERT INTO folders (user_id, name) VALUES (%s, %s) RETURNING id",
                  world["a"], f"rev-{uuid.uuid4().hex[:6]}")[0][0]  # fmt: skip
    _sql(world["db"], "INSERT INTO folder_shares (folder_id, user_id, role, invited_by) VALUES "
         "(%s, %s, 'viewer', %s)", folder, world["c"], world["a"])  # fmt: skip
    mid = _sql(world["db"], "INSERT INTO meetings (user_id, status, folder_id) VALUES (%s, "
               "'done', %s) RETURNING id", world["a"], folder)[0][0]  # fmt: skip
    session = _ask(client, "c", meetingId=str(mid)).json()["sessionId"]
    _sql(world["db"], "DELETE FROM folder_shares WHERE folder_id = %s", folder)
    assert _ask(client, "c", meetingId=str(mid), sessionId=session).status_code == 403
    assert client.get(f"/chat?sessionId={session}", headers=_as(client, "c")).status_code == 403


def test_an_admin_gets_no_extra_meetings(
    client: TestClient, world: dict[str, Any], ai: Provider
) -> None:
    from app.auth.jwt import issue_access_token

    _queries(world, "d")
    _meeting(world, "a", text="ADMIN-MUST-NOT-SEE")
    app: Any = client.app
    token = issue_access_token(app.state.auth.keys, world["d"], "admin")
    resp = client.post("/chat", headers={"Authorization": f"Bearer {token}"},
                       json={"message": "anything"})  # fmt: skip
    assert resp.status_code == 200 and "ADMIN-MUST-NOT-SEE" not in _excerpt_texts(ai)


def test_shared_excerpts_are_labelled(
    client: TestClient, world: dict[str, Any], ai: Provider
) -> None:
    _queries(world, "b")
    _meeting(world, "a", folder=True, text="FROM-A")
    assert _ask(client, "b", folderId=str(world["f"])).status_code == 200
    prompt = _excerpt_texts(ai)
    assert 'source="shared">\nFROM-A' in prompt and 'source="own"' not in prompt


def test_a_huge_body_is_refused(client: TestClient, world: dict[str, Any], ai: Provider) -> None:
    big = json.dumps({"message": "x" * 70_000}).encode()
    resp = client.post("/chat", headers={**_as(client, "a"), "content-type": "application/json"},
                       content=big)  # fmt: skip
    assert resp.status_code == 413


def test_a_meeting_without_a_locked_model_uses_the_system_default(
    client: TestClient, world: dict[str, Any], ai: Provider
) -> None:
    _queries(world, "a")
    mid = _meeting(world, "a", locked=False)
    assert _ask(client, "a", meetingId=str(mid)).status_code == 200
    assert ai.models == ["gemini:gemini-2.5-flash"]
    assert _sql(world["db"], "SELECT generation_provider FROM meetings WHERE id = %s", mid) == [
        (None,)
    ]  # chat never locks a model
