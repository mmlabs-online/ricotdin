"""ARC-04: what Sentry may receive (v1 OBS-01 + NFR-2: no request bodies, no secrets)."""

from typing import Any

from app.core.sentry import scrub_event


def test_request_body_cookies_and_auth_header_are_removed() -> None:
    event: dict[str, Any] = {
        "request": {
            "url": "https://api.test/meetings/1",
            "data": {"transcript": "secret meeting text"},
            "cookies": {"refresh": "r"},
            "headers": {"Authorization": "Bearer abc", "User-Agent": "x"},
        }
    }
    out = scrub_event(event)
    assert out is not None
    assert "data" not in out["request"] and "cookies" not in out["request"]
    assert out["request"]["headers"] == {"User-Agent": "x"}


def test_exception_messages_are_redacted() -> None:
    event: dict[str, Any] = {
        "exception": {
            "values": [{"type": "OperationalError", "value": "postgresql://u:pw@h/db down"}]
        }
    }
    out = scrub_event(event)
    assert out is not None
    assert "pw@" not in out["exception"]["values"][0]["value"]


def test_query_strings_are_dropped() -> None:
    event: dict[str, Any] = {
        "request": {"url": "https://api.test/auth/verify?token=abc", "query_string": "token=abc"}
    }
    out = scrub_event(event)
    assert out is not None
    assert "abc" not in str(out)
    assert out["request"]["url"] == "https://api.test/auth/verify"


def test_sdk_options_never_send_locals_bodies_or_pii() -> None:
    from app.core.sentry import sentry_options

    opts = sentry_options("https://k@o.ingest.sentry.io/1", "v2.0.0")
    assert opts["include_local_variables"] is False
    assert opts["max_request_body_size"] == "never"
    assert opts["send_default_pii"] is False
    assert opts["traces_sample_rate"] == 0.0
    assert opts["before_send"] is scrub_event


def test_breadcrumbs_and_extra_are_redacted() -> None:
    event: dict[str, Any] = {
        "extra": {"api_key": "AIzaSyA1234567890abcdefghijklmnopqrstu"},
        "breadcrumbs": {"values": [{"message": "Bearer abc.def.ghi"}]},
    }
    out = scrub_event(event)
    assert out is not None
    assert "AIza" not in str(out) and "abc.def.ghi" not in str(out)
