"""Anthropic Messages API with structured outputs (AIP-07), through the official ``anthropic`` SDK.

The SDK shares the service's ``httpx2.AsyncClient`` and never retries itself (``max_retries=0``):
rotation, cooldowns and retries stay in ``KeyPool`` / ``AIService``. The JSON comes back in the
first text block; ``stop_reason == "refusal"`` is a ``ModelRefused``. A key that cannot pay
(``billing_error`` / "credit balance is too low") or whose organization is on hold is reported as
a 401 so the pool disables that key, as for OpenAI's ``insufficient_quota``.
"""

from typing import Any

import anthropic
import httpx2
from anthropic.types import Message

from app.services.ai.catalog import ProviderInfo
from app.services.ai.schema import to_openai_strict_schema
from app.services.ai.types import (
    Completion,
    JsonRequest,
    ModelRefused,
    ProviderHTTPError,
    ProviderTransportError,
    retry_after,
    safe_code,
)

PROVIDER = "anthropic"
MAX_TOKENS = 16000  # an analysis JSON is far below this; a cut-off answer fails the JSON parse


def request_params(req: JsonRequest) -> dict[str, Any]:
    # No sampling parameters and no assistant prefill: current Claude models reject them.
    return {
        "model": req.model,
        "max_tokens": MAX_TOKENS,
        "system": req.system,
        "messages": [{"role": "user", "content": req.user}],
        "output_config": {
            "format": {"type": "json_schema", "schema": to_openai_strict_schema(req.schema)}
        },
    }


def parse_message(msg: Message) -> Completion:
    if msg.stop_reason == "refusal":
        raise ModelRefused("the model refused")
    try:
        text = next((b.text for b in msg.content if b.type == "text"), None)
        inp, out = int(msg.usage.input_tokens), int(msg.usage.output_tokens)
    except (TypeError, AttributeError, ValueError):  # a 2xx body that is not a Message
        raise ProviderHTTPError(PROVIDER, 502, "bad_response") from None
    if text is None:
        raise ModelRefused("no text in the response")
    return Completion(text=text, input_tokens=inp, output_tokens=out, total_tokens=inp + out)


def _error_fields(body: Any) -> tuple[str | None, str | None, str]:
    """(type, details.error_code, message) of an error body; the message is only matched."""
    err = body.get("error") if isinstance(body, dict) else None
    if not isinstance(err, dict):
        return None, None, ""
    details = err.get("details")
    kind, msg = err.get("type"), err.get("message")
    code = details.get("error_code") if isinstance(details, dict) else None
    return (
        kind if isinstance(kind, str) else None,
        code if isinstance(code, str) else None,
        msg if isinstance(msg, str) else "",
    )


def provider_error(exc: anthropic.APIError) -> Exception:
    """Map an SDK error to the errors ``KeyPool`` classifies. Never carries the message text."""
    if isinstance(exc, anthropic.APIConnectionError):  # includes APITimeoutError
        return ProviderTransportError(f"{PROVIDER} {type(exc).__name__}")
    if isinstance(exc, anthropic.APIStatusError):
        kind, code, msg = _error_fields(exc.body)
        if kind == "billing_error" or (exc.status_code == 400 and "credit balance" in msg.lower()):
            # no "quota" in the code: the pool classifier would read it as a rate limit
            return ProviderHTTPError(PROVIDER, 401, "key_out_of_credits")
        if code == "organization_on_hold":  # this key's org is disabled; other keys may work
            return ProviderHTTPError(PROVIDER, 401, code)
        return ProviderHTTPError(
            PROVIDER, exc.status_code, safe_code(kind), retry_after(exc.response.headers)
        )
    return ProviderHTTPError(PROVIDER, 502, "sdk_error")


class AnthropicAdapter:
    async def complete_json(
        self, http: httpx2.AsyncClient, provider: ProviderInfo, key: str, req: JsonRequest
    ) -> Completion:
        client = anthropic.AsyncAnthropic(
            api_key=key, base_url=provider.base_url, http_client=http,
            max_retries=0, timeout=http.timeout,  # the shared client's connect/read timeouts
        )  # fmt: skip
        try:
            msg = await client.messages.create(**request_params(req))
        except anthropic.APIError as exc:
            raise provider_error(exc) from None
        return parse_message(msg)
