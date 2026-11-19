"""Daily provider key health check (ARC-08e; port of v1 ``lib/keys/healthcheck*.ts``, §9i).

Every ``admin_config`` provider key (active and disabled) is probed with the cheapest
authenticated request and gets ``health_status`` / ``health_detail`` / ``health_checked_at``.
2xx and 429 → healthy (rate limits apply after auth), 401/403 → unhealthy, anything else or a
network error → unknown. A key that does not decrypt is unhealthy. Probes follow the provider's
``kind`` in the catalog, so a new provider is checked without code here; unlike v1, no key ever
travels in a URL. Keys and response bodies never reach logs or ``health_detail``.

ADM-12: a healthy key is then asked for one token with each model admins allow for its provider
(``app_settings['generation.allowed_models']``), and ``health_models`` records
``{model: ok | limited | unavailable | unknown}``. NULL = models not checked (the key failed, or
the provider has no generation models).
"""

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

import anyio
import httpx2
from sqlalchemy import text

from app.core.logging import get_logger
from app.db.session import Database
from app.domain.models import Pick, allowed_models
from app.services.ai import catalog
from app.services.platform import Platform

log = get_logger("worker.keyhealth")

WORKER = "ricotdin_worker"
SPEECHMATICS_BASE = "https://asr.api.speechmatics.com"
PROBE_TIMEOUT_S = 15.0
PING = "ping"

MODEL_OK = "ok"  # the key generated with this model
MODEL_LIMITED = "limited"  # rate-limited (429): the key may call it, just not right now
MODEL_UNAVAILABLE = "unavailable"  # refused: no access, unknown model, or out of credits
MODEL_UNKNOWN = "unknown"  # provider error or network: inconclusive
# error codes that mean "this key cannot use this model", whatever the HTTP status
_UNAVAILABLE_CODES = frozenset(
    {"model_not_found", "insufficient_quota", "not_found_error", "permission_error",
     "billing_error"}
)  # fmt: skip
# Known limit: Gemini answers "no quota for this model" (free tier limit 0, no billing) with the
# same 429 RESOURCE_EXHAUSTED as a rate limit, so such a model reads "limited", not "unavailable".


@dataclass(frozen=True)
class Probe:
    method: str
    url: str
    headers: dict[str, str] = field(repr=False)
    body: dict[str, Any] | None = None


@dataclass(frozen=True)
class Verdict:
    status: str  # healthy | unhealthy | unknown
    detail: str


def provider_of(config_key: str) -> str | None:
    return config_key[: -len("_api_key")] if config_key.endswith("_api_key") else None


def probe_for(config_key: str, key: str) -> Probe | None:
    name = provider_of(config_key)
    if name == "speechmatics":
        return Probe(
            "GET", f"{SPEECHMATICS_BASE}/v2/jobs?limit=1", {"Authorization": f"Bearer {key}"}
        )
    info = catalog.PROVIDERS.get(name or "")
    if info is None:
        return None
    if info.probe_model:
        # Listing models succeeds even when the key cannot call the model the app uses
        # (BUG-022): generate one token with that model instead.
        return _generate(info, info.probe_model, key)
    if info.kind == "gemini":
        return Probe("GET", f"{info.base_url}/models", {"x-goog-api-key": key})
    if info.kind == "openai_compat":
        return Probe("GET", f"{info.base_url}/models", {"Authorization": f"Bearer {key}"})
    if info.kind == "anthropic":
        return Probe("GET", f"{info.base_url}/v1/models", _anthropic_headers(key))
    return None  # a provider kind without a probe yet: left unchecked


def _anthropic_headers(key: str) -> dict[str, str]:
    # the same auth the SDK sends from the adapter (anthropic 2.x)
    return {"Authorization": f"Bearer {key}", "anthropic-version": "2026-10-21"}


def _generate(info: catalog.ProviderInfo, model: str, key: str) -> Probe | None:
    """A one-token generation with ``model`` (the id the provider is called with)."""
    if info.kind == "gemini":
        return Probe(
            "POST", f"{info.base_url}/models/{model}:generateContent", {"x-goog-api-key": key},
            {"contents": [{"role": "user", "parts": [{"text": PING}]}],
             "generationConfig": {"maxOutputTokens": 1}},
        )  # fmt: skip
    # max_tokens, as the adapters send: OpenAI reasoning models (o-series, gpt-5) reject it for
    # max_completion_tokens and would read "unknown" if added to the catalog.
    chat = {"model": model, "max_tokens": 1, "messages": [{"role": "user", "content": PING}]}
    if info.kind == "openai_compat":
        return Probe(
            "POST", f"{info.base_url}/chat/completions", {"Authorization": f"Bearer {key}"}, chat
        )
    if info.kind == "anthropic":
        return Probe("POST", f"{info.base_url}/v1/messages", _anthropic_headers(key), chat)
    return None


def models_to_check(config_key: str, allowed: list[Pick]) -> list[str]:
    """The allowed generation models of this key's provider, in allow-list order, once each."""
    name = provider_of(config_key)
    out: list[str] = []
    for provider, model in allowed:
        if provider == name and model not in out:
            out.append(model)
    return out


def model_probe_for(config_key: str, model: str, key: str) -> Probe | None:
    """A one-token call with a catalog model; a retired model is called as its replacement."""
    name = provider_of(config_key) or ""
    try:
        info, _ = catalog.find_model(name, model)
    except catalog.UnknownModel:
        return None
    return _generate(info, catalog.api_model(name, model), key)


def model_error_code(body: Any) -> str | None:
    """``error.code`` or ``error.type`` of a provider error body (OpenAI, xAI, Anthropic)."""
    err = body.get("error") if isinstance(body, dict) else None
    if not isinstance(err, dict):
        return None
    for name in ("code", "type"):
        if isinstance(err.get(name), str):
            return str(err[name])
    return None


def model_error_message(body: Any) -> str:
    """``error.message`` of a provider error body; only matched, never stored or logged."""
    err = body.get("error") if isinstance(body, dict) else None
    msg = err.get("message") if isinstance(err, dict) else None
    return msg if isinstance(msg, str) else ""


def classify_model(status: int, code: str | None, message: str = "") -> str:
    if 200 <= status < 300:
        return MODEL_OK
    if status == 400 and "credit balance" in message.lower():  # Anthropic, as its adapter reads it
        return MODEL_UNAVAILABLE
    if code in _UNAVAILABLE_CODES or status in (401, 403, 404):
        return MODEL_UNAVAILABLE
    if status == 429:
        return MODEL_LIMITED
    return MODEL_UNKNOWN


def classify_status(status: int) -> Verdict:
    if 200 <= status < 300:
        return Verdict("healthy", f"OK ({status})")
    if status == 429:
        return Verdict("healthy", "Rate-limited (429) — key is valid")
    if status == 401:
        return Verdict("unhealthy", "Rejected: invalid or revoked key (401)")
    if status == 403:
        return Verdict("unhealthy", "Rejected: key lacks permission (403)")
    if status >= 500:
        return Verdict("unknown", f"Provider error ({status}) — inconclusive")
    return Verdict("unknown", f"Unexpected response ({status}) — inconclusive")


def classify_error(exc: BaseException) -> Verdict:
    return Verdict("unknown", f"Network error — inconclusive ({type(exc).__name__})")


def summarize(verdicts: list[Verdict]) -> dict[str, int]:
    out = {"healthy": 0, "unhealthy": 0, "unknown": 0}
    for v in verdicts:
        out[v.status] += 1
    return out


async def probe(http: httpx2.AsyncClient, p: Probe) -> Verdict:
    try:
        resp = await http.request(p.method, p.url, headers=p.headers, json=p.body)
    except Exception as exc:  # noqa: BLE001 - network, or a key that is not a valid header
        return classify_error(exc)
    return classify_status(resp.status_code)


async def probe_model(http: httpx2.AsyncClient, p: Probe) -> str:
    try:
        resp = await http.request(p.method, p.url, headers=p.headers, json=p.body)
    except Exception:  # noqa: BLE001 - network, or a key that is not a valid header
        return MODEL_UNKNOWN
    body: Any = None
    if not 200 <= resp.status_code < 300:
        try:
            body = resp.json()
        except ValueError:  # not JSON
            body = None
    return classify_model(resp.status_code, model_error_code(body), model_error_message(body))


async def check_models(
    http: httpx2.AsyncClient, config_key: str, key: str, allowed: list[Pick]
) -> dict[str, str] | None:
    """``{model: result}`` for the allowed models of this key's provider; a retired model and its
    replacement share one call. None when the provider has no generation models."""
    if provider_of(config_key) not in catalog.PROVIDERS:
        return None
    name = provider_of(config_key) or ""
    probes: dict[str, Probe] = {}  # api model id -> probe: a retired model shares its call
    wanted: list[tuple[str, str]] = []
    for model in models_to_check(config_key, allowed):
        p = model_probe_for(config_key, model, key)
        if p is not None:
            api = catalog.api_model(name, model)
            probes.setdefault(api, p)
            wanted.append((model, api))
    results: dict[str, str] = {}

    async def one(api: str, p: Probe) -> None:
        results[api] = await probe_model(http, p)

    async with anyio.create_task_group() as tg:  # one key's models at once: ≤ the allow-list
        for api, p in probes.items():
            tg.start_soon(one, api, p)
    return {model: results[api] for model, api in wanted}


async def run_key_health(
    db: Database,
    platform: Platform,
    *,
    transport: httpx2.AsyncBaseTransport | None = None,
    group: str = WORKER,
) -> Mapping[str, int]:
    """Probe every stored key and record the verdicts. The worker runs it daily; the admin API
    runs it on demand as ``ricotdin_service`` (``group``)."""
    if not platform.keys.has_master:
        # Every stored key would look undecryptable: never mark good keys unhealthy for that.
        log.error("KEY_ENCRYPTION_SECRET is not set: key health check skipped")
        return {"healthy": 0, "unhealthy": 0, "unknown": 0}
    async with db.role_transaction(group) as conn:
        keys = await platform.keys.stored_keys(conn)
        raw = (
            await conn.execute(
                text("SELECT value FROM app_settings WHERE key = 'generation.allowed_models'")
            )
        ).scalar_one_or_none()
    allowed = allowed_models(json.loads(raw) if isinstance(raw, str) else raw)  # jsonb may be text
    verdicts: list[Verdict] = []

    async def record(key_id: str, v: Verdict, models: dict[str, str] | None) -> None:
        # each key on its own: a run cut short by the task timeout keeps the keys already checked
        async with db.role_transaction(group) as conn:
            await conn.execute(
                text(
                    "UPDATE admin_config SET health_status = :s, health_detail = :d, "
                    "health_models = CAST(:m AS jsonb), health_checked_at = now() WHERE id = :id"
                ),
                {"s": v.status, "d": v.detail, "id": key_id,
                 "m": None if models is None else json.dumps(models)},
            )  # fmt: skip
        verdicts.append(v)

    async with httpx2.AsyncClient(
        transport=transport, timeout=PROBE_TIMEOUT_S, follow_redirects=False
    ) as http:
        for stored in keys:
            if stored.key is None:
                await record(stored.id, Verdict("unhealthy", "Key could not be decrypted"), None)
                continue
            p = probe_for(stored.config_key, stored.key)
            if p is None:
                continue
            v = await probe(http, p)
            models = None
            if v.status == "healthy":  # a refused or unreachable key: its models stay unchecked
                models = await check_models(http, stored.config_key, stored.key, allowed)
            await record(stored.id, v, models)
    counts = summarize(verdicts)
    log.info("key health check done", extra=counts)
    return counts
