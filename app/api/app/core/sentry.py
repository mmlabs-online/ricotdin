"""Sentry (ARC-04, v1 OBS-01). Only initialised when SENTRY_DSN is set, once per process.

Meeting content must never reach Sentry (NFR-2): no request bodies, no frame local variables,
no cookies / Authorization / query strings, and every remaining value goes through ``redact``.
Errors are captured by the FastAPI integration only (not again from our error logs).
"""

from typing import Any

from app.core.redact import redact

_initialised = False


def scrub_event(event: dict[str, Any], hint: dict[str, Any] | None = None) -> dict[str, Any] | None:
    request = event.get("request")
    if isinstance(request, dict):
        request.pop("data", None)
        request.pop("cookies", None)
        request.pop("query_string", None)
        url = request.get("url")
        if isinstance(url, str):
            request["url"] = url.split("?", 1)[0]
        headers = request.get("headers")
        if isinstance(headers, dict):
            request["headers"] = {
                k: v for k, v in headers.items() if k.lower() not in {"authorization", "cookie"}
            }
    scrubbed: dict[str, Any] = redact(event)
    return scrubbed


def sentry_options(dsn: str, release: str) -> dict[str, Any]:
    return {
        "dsn": dsn,
        "release": release,
        "traces_sample_rate": 0.0,  # errors only, like v1
        "send_default_pii": False,
        "include_local_variables": False,
        "include_source_context": False,
        "max_request_body_size": "never",
        "before_send": scrub_event,
    }


def init_sentry(dsn: str | None, release: str) -> None:
    global _initialised
    if not dsn or _initialised:
        return
    import sentry_sdk
    from sentry_sdk.integrations.logging import LoggingIntegration

    sentry_sdk.init(
        **sentry_options(dsn, release),
        integrations=[LoggingIntegration(level=None, event_level=None)],
    )
    _initialised = True
