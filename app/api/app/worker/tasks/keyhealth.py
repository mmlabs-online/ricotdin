"""Daily provider key health check (ARC-08e; port of v1 ``lib/keys/healthcheck*.ts``, §9i).

Every ``admin_config`` provider key (active and disabled) is probed with the cheapest
authenticated request and gets ``health_status`` / ``health_detail`` / ``health_checked_at``.
2xx and 429 → healthy (rate limits apply after auth), 401/403 → unhealthy, anything else or a
network error → unknown. A key that does not decrypt is unhealthy. Probes follow the provider's
``kind`` in the catalog, so a new provider is checked without code here; unlike v1, no key ever
travels in a URL. Keys and response bodies never reach logs or ``health_detail``.
"""

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

import httpx2
from sqlalchemy import text

from app.core.logging import get_logger
from app.db.session import Database
from app.services.ai import catalog
from app.services.platform import Platform

log = get_logger("worker.keyhealth")

WORKER = "ricotdin_worker"
SPEECHMATICS_BASE = "https://asr.api.speechmatics.com"
PROBE_TIMEOUT_S = 15.0


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
    if info.kind == "gemini":
        return Probe("GET", f"{info.base_url}/models", {"x-goog-api-key": key})
    if info.kind == "openai_compat":
        bearer = {"Authorization": f"Bearer {key}"}
        if info.probe_model:
            return Probe(
                "POST", f"{info.base_url}/chat/completions", bearer,
                {"model": info.probe_model, "max_tokens": 1,
                 "messages": [{"role": "user", "content": "ping"}]},
            )  # fmt: skip
        return Probe("GET", f"{info.base_url}/models", bearer)
    return None  # a provider kind without a probe yet: left unchecked


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
    verdicts: list[tuple[str, Verdict]] = []
    async with httpx2.AsyncClient(
        transport=transport, timeout=PROBE_TIMEOUT_S, follow_redirects=False
    ) as http:
        for stored in keys:
            if stored.key is None:
                verdicts.append((stored.id, Verdict("unhealthy", "Key could not be decrypted")))
                continue
            p = probe_for(stored.config_key, stored.key)
            if p is None:
                continue
            verdicts.append((stored.id, await probe(http, p)))
    async with db.role_transaction(group) as conn:
        for key_id, v in verdicts:
            await conn.execute(
                text(
                    "UPDATE admin_config SET health_status = :s, health_detail = :d, "
                    "health_checked_at = now() WHERE id = :id"
                ),
                {"s": v.status, "d": v.detail, "id": key_id},
            )
    counts = summarize([v for _, v in verdicts])
    log.info("key health check done", extra=counts)
    return counts
