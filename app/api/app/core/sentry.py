"""Sentry (ARC-04, v1 OBS-01). Only initialised when SENTRY_DSN is set.

``scrub_event`` runs as ``before_send``: request bodies and cookies are dropped (meeting content
must never reach Sentry, NFR-2), the Authorization header is removed and every remaining value
is passed through ``redact``.
"""

from typing import Any

from app.core.redact import redact


def scrub_event(event: dict[str, Any], hint: dict[str, Any] | None = None) -> dict[str, Any] | None:
    request = event.get("request")
    if isinstance(request, dict):
        request.pop("data", None)
        request.pop("cookies", None)
        headers = request.get("headers")
        if isinstance(headers, dict):
            request["headers"] = {
                k: v for k, v in headers.items() if k.lower() not in {"authorization", "cookie"}
            }
    scrubbed: dict[str, Any] = redact(event)
    return scrubbed


def init_sentry(dsn: str | None, release: str) -> None:
    if not dsn:
        return
    import sentry_sdk

    sentry_sdk.init(
        dsn=dsn,
        release=release,
        traces_sample_rate=0.0,  # errors only, like v1
        send_default_pii=False,
        before_send=scrub_event,  # type: ignore[arg-type]
    )
