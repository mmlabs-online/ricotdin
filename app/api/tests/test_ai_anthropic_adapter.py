"""AIP-07: the Anthropic (Claude) adapter. Pure request building, response parsing and error
mapping on the official SDK's types, then full calls through ``AIService`` over
``httpx2.MockTransport`` (no network, no DB)."""

import json
from typing import Any

import anthropic
import httpx2
import pytest
from anthropic.types import Message

from app.services.ai import catalog
from app.services.ai.adapters.anthropic import (
    MAX_TOKENS,
    parse_message,
    provider_error,
    request_params,
)
from app.services.ai.service import AIRejected
from app.services.ai.types import (
    JsonRequest,
    ModelRefused,
    ProviderHTTPError,
    ProviderTransportError,
)
from app.services.keys.pool import KeyWithMeta
from tests.test_ai_service import SCHEMA, Server, Svc, call

REQ = JsonRequest(
    model="claude-haiku-5-5", system="SYS", user="USER", schema=SCHEMA, schema_name="analysis"
)
URL = "https://api.anthropic.com/v1/messages"


def message(
    content: list[dict[str, Any]], stop_reason: str = "end_turn", out_tokens: int = 7
) -> Message:
    return Message.model_validate(
        {
            "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-haiku-5-5",
            "content": content, "stop_reason": stop_reason, "stop_sequence": None,
            "usage": {"input_tokens": 5, "output_tokens": out_tokens},
        }
    )  # fmt: skip


def status_error(
    cls: type[anthropic.APIStatusError],
    status: int,
    body: Any,
    headers: dict[str, str] | None = None,
) -> anthropic.APIStatusError:
    resp = httpx2.Response(status, headers=headers or {}, request=httpx2.Request("POST", URL))
    return cls("error", response=resp, body=body)


def err_body(kind: str, msg: str = "x") -> dict[str, Any]:
    return {"type": "error", "error": {"type": kind, "message": msg}}


# --- request ------------------------------------------------------------------------------------


def test_request_params_use_structured_outputs_and_no_sampling_or_prefill() -> None:
    p = request_params(REQ)
    assert p["model"] == "claude-haiku-5-5"
    assert p["system"] == "SYS"
    assert p["messages"] == [{"role": "user", "content": "USER"}]  # no assistant prefill
    assert p["max_tokens"] == MAX_TOKENS
    fmt = p["output_config"]["format"]
    assert fmt["type"] == "json_schema"
    schema = fmt["schema"]
    assert schema["additionalProperties"] is False and schema["required"] == ["x"]
    assert schema["properties"]["x"] == {"anyOf": [{"type": "string"}, {"type": "null"}]}
    for absent in ("temperature", "top_p", "top_k", "thinking", "stop_sequences"):
        assert absent not in p


# --- response -----------------------------------------------------------------------------------


def test_parse_message_returns_the_json_text_and_usage() -> None:
    c = parse_message(message([{"type": "text", "text": '{"x": "a"}'}]))
    assert c.text == '{"x": "a"}'
    assert (c.input_tokens, c.output_tokens, c.total_tokens) == (5, 7, 12)


def test_parse_message_skips_thinking_blocks() -> None:
    m = message(
        [{"type": "thinking", "thinking": "", "signature": "sig"}, {"type": "text", "text": "{}"}]
    )
    assert parse_message(m).text == "{}"


def test_a_refusal_is_model_refused() -> None:
    with pytest.raises(ModelRefused):
        parse_message(message([], stop_reason="refusal"))


def test_no_text_block_is_model_refused() -> None:
    with pytest.raises(ModelRefused):
        parse_message(message([{"type": "thinking", "thinking": "", "signature": "s"}]))


def test_a_truncated_answer_is_returned_for_the_json_parser_to_reject() -> None:
    # max_tokens: not a refusal (no key change, no charge rule); the service's parse step
    # rejects the cut-off JSON and retries strictly, as for the other providers.
    c = parse_message(message([{"type": "text", "text": '{"x": "a'}], stop_reason="max_tokens"))
    assert c.text == '{"x": "a'


# --- errors -------------------------------------------------------------------------------------


def test_rate_limit_keeps_status_code_and_retry_after() -> None:
    e = provider_error(
        status_error(
            anthropic.RateLimitError, 429, err_body("rate_limit_error"), {"retry-after": "7"}
        )
    )
    assert isinstance(e, ProviderHTTPError)
    assert (e.provider, e.status_code, e.code, e.retry_after) == (
        "anthropic",
        429,
        "rate_limit_error",
        7.0,
    )


def test_bad_key_is_401() -> None:
    e = provider_error(
        status_error(anthropic.AuthenticationError, 401, err_body("authentication_error"))
    )
    assert isinstance(e, ProviderHTTPError) and e.status_code == 401


def test_out_of_credits_disables_the_key_like_openai() -> None:
    body = err_body("invalid_request_error", "Your credit balance is too low to access the API.")
    e = provider_error(status_error(anthropic.BadRequestError, 400, body))
    assert isinstance(e, ProviderHTTPError)
    assert (e.status_code, e.code) == (401, "key_out_of_credits")


def test_a_402_billing_error_disables_the_key() -> None:
    e = provider_error(status_error(anthropic.APIStatusError, 402, err_body("billing_error")))
    assert isinstance(e, ProviderHTTPError)
    assert (e.status_code, e.code) == (401, "key_out_of_credits")


def test_an_organization_on_hold_disables_the_key_instead_of_failing_the_meeting() -> None:
    body = {"type": "error", "error": {"type": "invalid_request_error", "message": "x",
                                       "details": {"error_code": "organization_on_hold"}}}  # fmt: skip
    e = provider_error(status_error(anthropic.BadRequestError, 400, body))
    assert isinstance(e, ProviderHTTPError)
    assert (e.status_code, e.code) == (401, "organization_on_hold")


def test_a_malformed_success_body_is_a_provider_error() -> None:
    broken = Message.model_construct(content=None, stop_reason="end_turn")
    with pytest.raises(ProviderHTTPError) as e:
        parse_message(broken)
    assert (e.value.status_code, e.value.code) == (502, "bad_response")


def test_the_sdk_logger_is_held_at_warning() -> None:
    import logging

    from app.core.logging import setup_logging

    setup_logging("DEBUG")
    assert logging.getLogger("anthropic").level == logging.WARNING


def test_other_bad_requests_stay_400() -> None:
    e = provider_error(
        status_error(
            anthropic.BadRequestError, 400, err_body("invalid_request_error", "bad schema")
        )
    )
    assert isinstance(e, ProviderHTTPError) and (e.status_code, e.code) == (
        400,
        "invalid_request_error",
    )


def test_overloaded_keeps_529() -> None:
    e = provider_error(status_error(anthropic.APIStatusError, 529, err_body("overloaded_error")))
    assert isinstance(e, ProviderHTTPError) and e.status_code == 529


def test_an_odd_error_body_has_no_code() -> None:
    e = provider_error(status_error(anthropic.InternalServerError, 500, "<html>oops</html>"))
    assert isinstance(e, ProviderHTTPError) and (e.status_code, e.code) == (500, None)


def test_network_and_timeouts_are_transport_errors() -> None:
    req = httpx2.Request("POST", URL)
    assert isinstance(
        provider_error(anthropic.APIConnectionError(request=req)), ProviderTransportError
    )
    assert isinstance(
        provider_error(anthropic.APITimeoutError(request=req)), ProviderTransportError
    )


# --- catalog ------------------------------------------------------------------------------------


def test_catalog_has_anthropic_and_the_three_current_models() -> None:
    p = catalog.PROVIDERS["anthropic"]
    assert (p.kind, p.base_url, p.label) == ("anthropic", "https://api.anthropic.com", "Anthropic")
    models = {m.model for m in catalog.MODELS if m.provider == "anthropic"}
    assert models == {"claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"}


# --- through AIService --------------------------------------------------------------------------


def claude_ok(text: str) -> tuple[int, Any]:
    return 200, message([{"type": "text", "text": text}]).model_dump(mode="json")


K1, K2 = KeyWithMeta(None, "key-one"), KeyWithMeta(None, "key-two")


def test_full_call_sends_the_key_and_parses_json() -> None:
    server = Server(claude_ok('{"x": "a"}'))
    svc = Svc(server, [K1])
    assert call(svc, "anthropic", "claude-haiku-5-5") == {"x": "a"}
    req = server.requests[0]
    assert str(req.url) == URL
    # SDK 2.x sends the API key as a bearer token (anthropic-version 2026-10-21)
    assert req.headers["authorization"] == "Bearer key-one"
    body = json.loads(req.content)
    assert body["model"] == "claude-haiku-5-5"
    assert body["output_config"]["format"]["type"] == "json_schema"
    assert svc.usage[0]["provider"] == "anthropic"
    # the shared client's timeouts apply (connect 30 s), not one flat SDK timeout
    assert req.headers["x-stainless-read-timeout"] == "300.0"
    assert req.extensions["timeout"]["connect"] == 30.0
    assert len(server.requests) == 1  # the SDK does not retry on its own (max_retries=0)


def test_a_rate_limited_key_hands_over_to_the_next_key() -> None:
    server = Server(
        (429, err_body("rate_limit_error"), {"retry-after": "3"}), claude_ok('{"x": "b"}')
    )
    assert call(Svc(server, [K1, K2]), "anthropic", "claude-haiku-5-5") == {"x": "b"}
    assert [r.headers["authorization"] for r in server.requests] == [
        "Bearer key-one", "Bearer key-two",
    ]  # fmt: skip


def test_a_refusal_through_the_service_is_rejected_without_trying_another_key() -> None:
    refusal = (200, message([], stop_reason="refusal").model_dump(mode="json"))
    server = Server(refusal)
    with pytest.raises(AIRejected):
        call(Svc(server, [K1, K2]), "anthropic", "claude-haiku-5-5")
    assert len(server.requests) == 1
