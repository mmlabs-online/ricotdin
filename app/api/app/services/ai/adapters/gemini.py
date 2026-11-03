"""Gemini ``generateContent`` over REST (ARC-08c; v1 ``lib/ai/adapters/gemini.ts``, no SDK).

The key travels in the ``x-goog-api-key`` header, never in the URL. A safety block (prompt or
candidate) is a ``ModelRefused``.
"""

import re
from typing import Any

import httpx2

from app.services.ai.catalog import ProviderInfo
from app.services.ai.schema import to_gemini_schema
from app.services.ai.types import (
    Completion,
    JsonRequest,
    ModelRefused,
    post_json,
    token_count,
)

_BLOCKED = {"SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "LANGUAGE"}


def request_body(req: JsonRequest) -> dict[str, Any]:
    return {
        "systemInstruction": {"parts": [{"text": req.system}]},
        "contents": [{"role": "user", "parts": [{"text": req.user}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": to_gemini_schema(req.schema),
        },
    }


def error_code(body: Any) -> str | None:
    """``API_KEY_INVALID`` (from details) or the status (``RESOURCE_EXHAUSTED``, …): the pool's
    classifier reads both from the error message."""
    err = body.get("error") if isinstance(body, dict) else None
    if not isinstance(err, dict):
        return None
    for detail in err.get("details") or []:
        if isinstance(detail, dict) and isinstance(detail.get("reason"), str):
            return str(detail["reason"])
    status = err.get("status")
    return status if isinstance(status, str) else None


def retry_delay(body: Any) -> float | None:
    """``RetryInfo.retryDelay`` ("37s", "1.5s") of a 429 body."""
    err = body.get("error") if isinstance(body, dict) else None
    for detail in (err.get("details") or []) if isinstance(err, dict) else []:
        delay = detail.get("retryDelay") if isinstance(detail, dict) else None
        if isinstance(delay, str) and re.fullmatch(r"\d{1,5}(?:\.\d+)?s", delay):
            return min(float(delay[:-1]), 3600.0)
    return None


def parse_response(body: dict[str, Any]) -> Completion:
    feedback = body.get("promptFeedback")
    if isinstance(feedback, dict) and feedback.get("blockReason"):
        raise ModelRefused("gemini blocked the prompt")
    candidates = body.get("candidates")
    first = candidates[0] if isinstance(candidates, list) and candidates else None
    if not isinstance(first, dict):
        raise ModelRefused("gemini returned no candidate")
    if first.get("finishReason") in _BLOCKED:
        raise ModelRefused(f"gemini stopped: {first['finishReason']}")
    content = first.get("content")
    parts = content.get("parts") if isinstance(content, dict) else None
    text = "".join(
        p["text"] for p in parts or [] if isinstance(p, dict) and isinstance(p.get("text"), str)
    )
    usage = body.get("usageMetadata")
    usage = usage if isinstance(usage, dict) else {}
    return Completion(
        text,
        token_count(usage.get("promptTokenCount")),
        token_count(usage.get("candidatesTokenCount")),
        token_count(usage.get("totalTokenCount")),
    )


class GeminiAdapter:
    async def complete_json(
        self, http: httpx2.AsyncClient, provider: ProviderInfo, key: str, req: JsonRequest
    ) -> Completion:
        body = await post_json(
            http, provider.name, f"{provider.base_url}/models/{req.model}:generateContent",
            {"x-goog-api-key": key}, request_body(req), error_code, retry_delay,
        )  # fmt: skip
        return parse_response(body)
