"""Anthropic Messages API with structured outputs (AIP-07), through the official ``anthropic`` SDK.

The SDK shares the service's ``httpx2.AsyncClient`` and never retries itself (``max_retries=0``):
rotation, cooldowns and retries stay in ``KeyPool`` / ``AIService``. The JSON comes back in the
first text block; ``stop_reason == "refusal"`` is a ``ModelRefused``. "Credit balance is too low"
(a 400) is reported as a 401 so the pool disables that key, as for OpenAI's ``insufficient_quota``.
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
TIMEOUT_S = 300.0  # matches the service client's read timeout


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
    text = next((b.text for b in msg.content if b.type == "text"), None)
    if text is None:
        raise ModelRefused("no text in the response")
    inp, out = msg.usage.input_tokens, msg.usage.output_tokens
    return Completion(text=text, input_tokens=inp, output_tokens=out, total_tokens=inp + out)


def _error_fields(body: Any) -> tuple[str | None, str]:
    err = body.get("error") if isinstance(body, dict) else None
    if not isinstance(err, dict):
        return None, ""
    kind, msg = err.get("type"), err.get("message")
    return (kind if isinstance(kind, str) else None), (msg if isinstance(msg, str) else "")


def provider_error(exc: anthropic.APIError) -> Exception:
    """Map an SDK error to the errors ``KeyPool`` classifies. Never carries the message text."""
    if isinstance(exc, anthropic.APIConnectionError):  # includes APITimeoutError
        return ProviderTransportError(f"{PROVIDER} {type(exc).__name__}")
    if isinstance(exc, anthropic.APIStatusError):
        kind, msg = _error_fields(exc.body)
        if exc.status_code == 400 and "credit balance" in msg.lower():
            # no "quota" in the code: the pool classifier would read it as a rate limit
            return ProviderHTTPError(PROVIDER, 401, "key_out_of_credits")
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
            max_retries=0, timeout=TIMEOUT_S,
        )  # fmt: skip
        try:
            msg = await client.messages.create(**request_params(req))
        except anthropic.APIError as exc:
            raise provider_error(exc) from None
        return parse_message(msg)
