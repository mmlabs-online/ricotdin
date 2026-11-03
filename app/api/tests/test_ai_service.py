"""ARC-08c: adapters (Gemini, OpenAI-compatible) and ``AIService`` over ``httpx2.MockTransport``
(no network, no DB). Ports the behaviour of v1 ``tests/ai-gemini-adapter.test.ts`` and
``ai-openai-adapter.test.ts`` (request shape, same-key strict retry, refusal, usage) and adds
key rotation, usage rows for failed calls and the "new provider needs no other change" check."""

import json
import uuid
from collections.abc import Callable
from typing import Any

import anyio
import httpx2
import pytest

from app.services.ai import catalog
from app.services.ai.catalog import ModelInfo, ProviderInfo
from app.services.ai.service import (
    AIBadOutput,
    AIRejected,
    AIService,
    AIUnavailable,
    ParseFailed,
    UsageContext,
)
from app.services.ai.types import Completion, JsonRequest
from app.services.keys.pool import KeyWithMeta, NoUsableKeys
from app.services.keys.source import KeySource

KID = "00000000-0000-0000-0000-0000000000a1"
SCHEMA = {"type": "object", "properties": {"x": {"type": "string", "nullable": True}}}
MEETING = uuid.uuid4()


def gemini_ok(text: str, tokens: int = 30) -> tuple[int, Any]:
    return 200, {
        "candidates": [{"content": {"parts": [{"text": text}]}, "finishReason": "STOP"}],
        "usageMetadata": {"promptTokenCount": 20, "candidatesTokenCount": tokens - 20,
                          "totalTokenCount": tokens},
    }  # fmt: skip


def openai_ok(text: str | None, refusal: str | None = None) -> tuple[int, Any]:
    return 200, {
        "choices": [{"message": {"content": text, "refusal": refusal}}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 7, "total_tokens": 12},
    }


class Server:
    def __init__(self, *answers: Any) -> None:
        self.answers = list(answers)
        self.requests: list[httpx2.Request] = []

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        request.read()
        self.requests.append(request)
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(answer, Exception):
            raise answer
        status, body = answer[0], answer[1]
        headers = answer[2] if len(answer) > 2 else {}
        return httpx2.Response(status, json=body, headers=headers)

    def body(self, i: int) -> Any:
        return json.loads(self.requests[i].content)


class Svc(AIService):
    def __init__(self, server: Server, keys: list[KeyWithMeta], **kw: Any) -> None:
        self.sleeps: list[float] = []

        async def sleep(s: float) -> None:
            self.sleeps.append(s)

        super().__init__(
            KeySource(None, {}), transport=httpx2.MockTransport(server.handle), sleep=sleep,
            jitter=lambda: 1.0, **kw,
        )  # fmt: skip
        self.all_keys = keys
        self.usage: list[dict[str, Any]] = []
        self.loads = 0

    async def _load_keys(self, db: Any, group: str, provider: str) -> list[KeyWithMeta]:
        self.loads += 1
        return self.keys.usable(self.all_keys)

    async def _write_usage(self, db: Any, group: str, rows: list[dict[str, Any]]) -> None:
        self.usage.extend(rows)


def parse_json(raw: str) -> dict[str, Any]:
    try:
        data = json.loads(raw)
    except ValueError:
        raise ParseFailed("not json") from None
    if not isinstance(data, dict):
        raise ParseFailed("not an object")
    return data


def call(svc: AIService, provider: str = "gemini", model: str = "gemini-2.5-flash",
         retry: str | None = "STRICT", parse: Callable[[str], Any] = parse_json) -> Any:  # fmt: skip
    async def go() -> Any:
        return await svc.generate_json(
            None,  # type: ignore[arg-type]  # loaders are overridden
            "ricotdin_worker", provider, model, system="SYS", user="USER", retry_user=retry,
            schema=SCHEMA, schema_name="meeting_analysis", operation="analyze", parse=parse,
            usage=UsageContext(MEETING, None),
        )  # fmt: skip

    return anyio.run(go)


K1, K2 = KeyWithMeta(KID, "key-one"), KeyWithMeta(None, "key-two")


# --- request shapes -----------------------------------------------------------------------------


def test_gemini_request_uses_a_header_key_and_the_converted_schema() -> None:
    server = Server(gemini_ok('{"x": "a"}'))
    assert call(Svc(server, [K1])) == {"x": "a"}
    req = server.requests[0]
    assert req.url.path == "/v1beta/models/gemini-2.5-flash:generateContent"
    assert req.url.host == "generativelanguage.googleapis.com"
    assert "key" not in req.url.params and req.headers["x-goog-api-key"] == "key-one"
    body = server.body(0)
    assert body["systemInstruction"] == {"parts": [{"text": "SYS"}]}
    assert body["contents"] == [{"role": "user", "parts": [{"text": "USER"}]}]
    cfg = body["generationConfig"]
    assert cfg["responseMimeType"] == "application/json"
    assert cfg["responseSchema"]["properties"]["x"] == {"type": "STRING", "nullable": True}


@pytest.mark.parametrize(
    ("provider", "model", "host"),
    [("openai", "gpt-4o", "api.openai.com"), ("grok", "grok-4", "api.x.ai")],
)
def test_openai_compatible_request(provider: str, model: str, host: str) -> None:
    server = Server(openai_ok('{"x": null}'))
    assert call(Svc(server, [K2]), provider, model) == {"x": None}
    req = server.requests[0]
    assert (req.url.host, req.url.path.endswith("/chat/completions")) == (host, True)
    assert req.headers["authorization"] == "Bearer key-two"
    body = server.body(0)
    assert body["model"] == model
    assert body["messages"] == [{"role": "system", "content": "SYS"},
                                {"role": "user", "content": "USER"}]  # fmt: skip
    fmt = body["response_format"]
    assert fmt["type"] == "json_schema" and fmt["json_schema"]["strict"] is True
    assert fmt["json_schema"]["name"] == "meeting_analysis"
    assert fmt["json_schema"]["schema"]["additionalProperties"] is False


# --- strict retry on the same key ---------------------------------------------------------------


def test_unusable_answer_is_retried_once_on_the_same_key_with_the_strict_prompt() -> None:
    server = Server(gemini_ok("```not json"), gemini_ok('{"x": "ok"}'))
    svc = Svc(server, [K1, K2])
    assert call(svc) == {"x": "ok"}
    assert [r.headers["x-goog-api-key"] for r in server.requests] == ["key-one", "key-one"]
    assert server.body(1)["contents"][0]["parts"][0]["text"] == "STRICT"
    assert [u["status"] for u in svc.usage] == ["ok", "ok"]
    assert svc.usage[0]["tot"] == 30 and svc.usage[0]["qty"] == 30
    assert svc.usage[0]["key"] == uuid.UUID(KID) and svc.usage[0]["meeting"] == MEETING


def test_unusable_twice_is_bad_output_without_rotating() -> None:
    server = Server(gemini_ok("nope"))
    svc = Svc(server, [K1, K2])
    with pytest.raises(AIBadOutput):
        call(svc)
    assert len(server.requests) == 2 and svc.sleeps == []


def test_no_strict_prompt_means_no_retry() -> None:
    server = Server(gemini_ok("nope"))
    with pytest.raises(AIBadOutput):
        call(Svc(server, [K1]), retry=None)
    assert len(server.requests) == 1


# --- refusal / rejection ------------------------------------------------------------------------


@pytest.mark.parametrize(
    "answer",
    [
        openai_ok(None, refusal="I can't"),
        (200, {"choices": []}),
    ],
)
def test_openai_refusal_is_rejected_and_not_retried(answer: Any) -> None:
    server = Server(answer)
    with pytest.raises(AIRejected) as exc:
        call(Svc(server, [K1, K2]), "openai", "gpt-4o")
    assert len(server.requests) == 1
    assert exc.value.public_message == "The AI model declined to process this meeting."


@pytest.mark.parametrize(
    "body",
    [{"promptFeedback": {"blockReason": "SAFETY"}},
     {"candidates": [{"finishReason": "SAFETY", "content": {"parts": []}}]}, {}],
)  # fmt: skip
def test_gemini_safety_block_is_rejected(body: Any) -> None:
    server = Server((200, body))
    with pytest.raises(AIRejected):
        call(Svc(server, [K1, K2]))
    assert len(server.requests) == 1


def test_a_400_is_rejected_without_rotating() -> None:
    server = Server((400, {"error": {"status": "INVALID_ARGUMENT", "message": "bad schema"}}))
    with pytest.raises(AIRejected) as exc:
        call(Svc(server, [K1, K2]))
    assert len(server.requests) == 1 and "key-" not in str(exc.value.detail)


def test_unknown_model_is_rejected_before_any_call() -> None:
    server = Server(gemini_ok("{}"))
    with pytest.raises(AIRejected):
        call(Svc(server, [K1]), "gemini", "gemini-9")
    assert server.requests == []


# --- key pool -----------------------------------------------------------------------------------


def test_429_cools_the_key_down_and_rotates() -> None:
    server = Server((429, {"error": {"status": "RESOURCE_EXHAUSTED"}}, {"retry-after": "7"}),
                    gemini_ok('{"x": "a"}'))  # fmt: skip
    svc = Svc(server, [K1, K2])
    assert call(svc) == {"x": "a"}
    assert [r.headers["x-goog-api-key"] for r in server.requests] == ["key-one", "key-two"]
    assert [(u["status"], u["http"]) for u in svc.usage] == [("rate_limited", 429), ("ok", None)]


@pytest.mark.parametrize(
    ("provider", "model", "answer"),
    [
        ("gemini", "gemini-2.5-flash",
         (400, {"error": {"status": "INVALID_ARGUMENT", "details": [{"reason": "API_KEY_INVALID"}]}})),
        ("openai", "gpt-4o", (401, {"error": {"code": "invalid_api_key"}})),
        ("openai", "gpt-4o", (429, {"error": {"code": "insufficient_quota"}})),
    ],
)  # fmt: skip
def test_a_dead_key_is_disabled_for_later_calls(provider: str, model: str, answer: Any) -> None:
    ok = gemini_ok('{"x": "a"}') if provider == "gemini" else openai_ok('{"x": "a"}')
    server = Server(answer, ok, ok)
    svc = Svc(server, [K1, K2])
    assert call(svc, provider, model) == {"x": "a"}
    assert svc.keys.usable([K1]) == []  # skipped by every later pool of this process
    call(svc, provider, model)
    assert len(server.requests) == 3


def test_network_errors_on_every_key_are_unavailable() -> None:
    server = Server(httpx2.ConnectError("reset"))
    svc = Svc(server, [K1, K2])
    with pytest.raises(AIUnavailable) as exc:
        call(svc)
    assert "key-" not in str(exc.value.detail)
    assert {u["status"] for u in svc.usage} == {"error"}


def test_no_keys_is_unavailable() -> None:
    with pytest.raises(NoUsableKeys):
        call(Svc(Server(gemini_ok("{}")), []))


def test_one_pool_per_provider_rebuilt_only_when_keys_change() -> None:
    server = Server(gemini_ok('{"x": "a"}'))
    svc = Svc(server, [K1])
    call(svc)
    first = svc._pools["gemini"].pool
    call(svc)
    assert svc._pools["gemini"].pool is first
    svc.all_keys = [K1, K2]
    call(svc)
    assert svc._pools["gemini"].pool is not first


# --- extensibility: a new provider kind needs only an adapter + catalog rows --------------------


class EchoAdapter:
    def __init__(self) -> None:
        self.seen: list[tuple[str, str, JsonRequest]] = []

    async def complete_json(
        self, http: httpx2.AsyncClient, provider: ProviderInfo, key: str, req: JsonRequest
    ) -> Completion:
        self.seen.append((provider.base_url, key, req))
        return Completion('{"x": "from claude"}', 1, 2, 3)


def test_a_new_provider_plugs_in_without_touching_the_service(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    claude = ProviderInfo("anthropic", "anthropic", "https://api.anthropic.com/v1", "Claude")
    monkeypatch.setitem(catalog.PROVIDERS, "anthropic", claude)
    monkeypatch.setattr(
        catalog, "MODELS", (*catalog.MODELS, ModelInfo("anthropic", "claude-x", "Claude — x"))
    )
    echo = EchoAdapter()
    svc = Svc(Server(gemini_ok("{}")), [K2], adapters={"anthropic": echo})
    assert call(svc, "anthropic", "claude-x") == {"x": "from claude"}
    base, key, req = echo.seen[0]
    assert (base, key, req.model, req.schema_name) == (
        "https://api.anthropic.com/v1", "key-two", "claude-x", "meeting_analysis",
    )  # fmt: skip
    assert svc.usage[0]["provider"] == "anthropic" and svc.usage[0]["tot"] == 3


def test_repr_hides_keys() -> None:
    svc = Svc(Server(gemini_ok("{}")), [K1])
    assert repr(svc) == "AIService()"


# --- review round 1 ------------------------------------------------------------------------------


def test_xai_bad_key_400_disables_the_key() -> None:
    bad = (400, {"code": "Client specified an invalid argument",
                 "error": "Incorrect API key provided: xa***. You can obtain an API key"})  # fmt: skip
    server = Server(bad, openai_ok('{"x": "a"}'))
    svc = Svc(server, [K1, K2])
    assert call(svc, "grok", "grok-4") == {"x": "a"}
    assert svc.keys.usable([K1]) == [] and len(server.requests) == 2


def test_one_rate_limited_key_reports_when_it_is_ready() -> None:
    body = {"error": {"status": "RESOURCE_EXHAUSTED",
                      "details": [{"@type": "type.googleapis.com/google.rpc.RetryInfo",
                                   "retryDelay": "42s"}]}}  # fmt: skip
    svc = Svc(Server((429, body)), [K1])
    with pytest.raises(AIUnavailable) as exc:
        call(svc)
    assert exc.value.retry_after is not None and 40 <= exc.value.retry_after <= 42


def test_network_failure_has_no_ready_hint() -> None:
    with pytest.raises(AIUnavailable) as exc:
        call(Svc(Server(httpx2.ConnectError("x")), [K1]))
    assert exc.value.retry_after is None


def test_a_parser_bug_is_bad_output_not_a_key_rotation() -> None:
    def broken(raw: str) -> Any:
        raise OverflowError("date value out of range")

    server = Server(gemini_ok("{}"))
    svc = Svc(server, [K1, K2])
    with pytest.raises(AIBadOutput):
        call(svc, parse=broken)
    assert len(server.requests) == 2 and svc.sleeps == []  # first + strict, same key


def test_a_cancelled_call_still_records_usage() -> None:
    class Slow:
        async def complete_json(self, *a: Any) -> Completion:
            await anyio.sleep(10)
            raise AssertionError("unreachable")

    svc = Svc(Server(gemini_ok("{}")), [K1], adapters={"gemini": Slow()})

    async def go() -> None:
        with anyio.move_on_after(0.05):
            await svc.generate_json(
                None,  # type: ignore[arg-type]
                "ricotdin_worker", "gemini", "gemini-2.5-flash", system="S", user="U",
                retry_user=None, schema=SCHEMA, schema_name="n", operation="analyze",
                parse=parse_json, usage=UsageContext(),
            )  # fmt: skip

    anyio.run(go)
    assert [u["status"] for u in svc.usage] == ["error"]
