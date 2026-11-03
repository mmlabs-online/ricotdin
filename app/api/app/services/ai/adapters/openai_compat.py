"""OpenAI Chat Completions with Structured Outputs (ARC-08c; v1 ``lib/ai/adapters/openai.ts``).

Serves every OpenAI-compatible provider (OpenAI, Grok/xAI, and later DeepSeek, Mistral, …):
only ``ProviderInfo.base_url`` differs. ``insufficient_quota`` (out of credits) is reported as a
401 so the pool disables that key (v1). A refusal is a ``ModelRefused``.
"""

import re
from typing import Any

import httpx2

from app.services.ai.catalog import ProviderInfo
from app.services.ai.schema import to_openai_strict_schema
from app.services.ai.types import (
    Completion,
    JsonRequest,
    ModelRefused,
    ProviderHTTPError,
    post_json,
    token_count,
)


def request_body(req: JsonRequest) -> dict[str, Any]:
    return {
        "model": req.model,
        "messages": [
            {"role": "system", "content": req.system},
            {"role": "user", "content": req.user},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": req.schema_name,
                "schema": to_openai_strict_schema(req.schema),
                "strict": True,
            },
        },
    }


_BAD_KEY = re.compile(r"(incorrect|invalid) api key", re.I)


def error_code(body: Any) -> str | None:
    """OpenAI ``{"error": {"code", "type"}}``; xAI answers a bad key with 400 and
    ``{"error": "Incorrect API key provided…"}`` → ``invalid_api_key`` (pool: key disabled)."""
    err = body.get("error") if isinstance(body, dict) else None
    if isinstance(err, str):
        return "invalid_api_key" if _BAD_KEY.search(err) else None
    if not isinstance(err, dict):
        return None
    if isinstance(err.get("message"), str) and _BAD_KEY.search(err["message"]):
        return "invalid_api_key"
    for field in ("code", "type"):
        if isinstance(err.get(field), str):
            return str(err[field])
    return None


def parse_response(body: dict[str, Any]) -> Completion:
    choices = body.get("choices")
    first = choices[0] if isinstance(choices, list) and choices else None
    message = first.get("message") if isinstance(first, dict) else None
    if not isinstance(message, dict):
        raise ModelRefused("no choice in the response")
    if message.get("refusal"):
        raise ModelRefused("the model refused")
    content = message.get("content")
    usage = body.get("usage")
    usage = usage if isinstance(usage, dict) else {}
    return Completion(
        content if isinstance(content, str) else "",
        token_count(usage.get("prompt_tokens")),
        token_count(usage.get("completion_tokens")),
        token_count(usage.get("total_tokens")),
    )


class OpenAICompatAdapter:
    async def complete_json(
        self, http: httpx2.AsyncClient, provider: ProviderInfo, key: str, req: JsonRequest
    ) -> Completion:
        try:
            body = await post_json(
                http, provider.name, f"{provider.base_url}/chat/completions",
                {"Authorization": f"Bearer {key}"}, request_body(req), error_code,
            )  # fmt: skip
        except ProviderHTTPError as exc:
            if exc.code == "invalid_api_key" and exc.status_code == 400:  # xAI: bad key
                raise ProviderHTTPError(exc.provider, 401, exc.code) from None
            if exc.code == "insufficient_quota":  # out of credits: disable the key (v1)
                # no "quota" in the code: the pool classifier would read it as a rate limit
                raise ProviderHTTPError(exc.provider, 401, "key_out_of_credits") from None
            raise
        return parse_response(body)
