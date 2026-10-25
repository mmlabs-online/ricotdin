"""Sentry (ARC-04, v1 OBS-01). Only initialised when SENTRY_DSN is set, once per process.

Meeting content must never reach Sentry (NFR-2): no request bodies, no frame local variables,
no cookies / Authorization / query strings, and every remaining value goes through ``redact``.
Unhandled errors are reported by the catch-all middleware (``capture_unhandled``), which answers
the 500 itself so Sentry's ASGI integration never sees them; error *logs* do not create events.
"""

from typing import Any

from app.core.redact import redact

_initialised = False
# Tests may install an in-memory sentry_sdk Transport subclass here (never set in production).
TEST_TRANSPORT: Any = None


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
                k: v
                for k, v in headers.items()
                if k.lower() not in {"authorization", "cookie", "set-cookie"}
            }
    breadcrumbs = event.get("breadcrumbs")
    if isinstance(breadcrumbs, dict):
        for crumb in breadcrumbs.get("values", []) or []:
            data = crumb.get("data") if isinstance(crumb, dict) else None
            if isinstance(data, dict):
                data.pop("http.query", None)
                if isinstance(data.get("url"), str):
                    data["url"] = data["url"].split("?", 1)[0]
    scrubbed: dict[str, Any] = redact(event)
    return scrubbed


def sentry_options(dsn: str, release: str) -> dict[str, Any]:
    return {
        "dsn": dsn,
        "release": release,
        "traces_sample_rate": 0.0,  # errors only, like v1
        # PII collection stays at the SDK default (off); send_default_pii is deprecated in 2.7x.
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

    options = sentry_options(dsn, release)
    if TEST_TRANSPORT is not None:
        options["transport"] = TEST_TRANSPORT
    sentry_sdk.init(**options, integrations=[LoggingIntegration(level=None, event_level=None)])
    _initialised = True


def capture_unhandled(exc: BaseException) -> None:
    """Report an exception the catch-all answered with a 500 (no-op without Sentry)."""
    if not _initialised:
        return
    import sentry_sdk

    sentry_sdk.capture_exception(exc)


def reset_for_tests() -> None:
    """Disable a test client and allow ``init_sentry`` again (tests only)."""
    global _initialised
    if _initialised:
        import sentry_sdk

        sentry_sdk.init(dsn=None)
    _initialised = False
