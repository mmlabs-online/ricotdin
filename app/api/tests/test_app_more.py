"""ARC-04 review round 1: HTTP behaviour the first version got wrong."""

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from app.core.settings import Settings, parse_origins
from app.main import create_app

ORIGIN = "https://app.ricotdin.test"


def _client(**env: str) -> TestClient:
    app = create_app(Settings.model_validate({"ALLOWED_ORIGINS": ORIGIN, **env}))
    router = APIRouter()

    @router.get("/boom")
    def boom() -> None:
        raise RuntimeError("password=hunter2")

    app.include_router(router)
    # raise_server_exceptions=True: an exception escaping our catch-all would fail the test.
    return TestClient(app, raise_server_exceptions=True)


def test_500_is_json_with_security_and_cors_headers_and_never_reraised() -> None:
    r = _client().get("/boom", headers={"Origin": ORIGIN})
    assert r.status_code == 500
    assert r.json()["error"]["code"] == "internal"
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers.get("access-control-allow-origin") == ORIGIN
    assert "hunter2" not in r.text


def test_head_health_for_uptime_checkers() -> None:
    assert _client().head("/health").status_code == 200


def test_405_keeps_the_allow_header() -> None:
    r = _client().post("/health")
    assert r.status_code == 405
    assert "GET" in r.headers.get("allow", "")
    assert r.json()["error"]["code"] == "method_not_allowed"


def test_csp_and_no_store_on_api_responses() -> None:
    r = _client().get("/health")
    assert r.headers["content-security-policy"] == "default-src 'none'; frame-ancestors 'none'"
    assert r.headers["cache-control"] == "no-store"


def test_retry_after_is_readable_cross_origin() -> None:
    r = _client().get("/health", headers={"Origin": ORIGIN})
    assert "retry-after" in r.headers.get("access-control-expose-headers", "").lower()


def test_docs_are_off_by_default_and_on_when_asked() -> None:
    off = _client()
    assert off.get("/docs").status_code == 404
    assert off.get("/openapi.json").status_code == 404
    on = _client(API_DOCS="1")
    assert on.get("/openapi.json").status_code == 200
    assert on.get("/docs").status_code == 200


@pytest.mark.parametrize("origin", ["http://app.ricotdin.test", "http://192.168.1.5:5173"])
def test_plain_http_origins_are_refused_except_localhost(origin: str) -> None:
    with pytest.raises(ValueError, match="https"):
        parse_origins(origin)


@pytest.mark.parametrize("origin", ["http://localhost:5173", "http://127.0.0.1:5173"])
def test_localhost_http_origins_are_allowed_for_development(origin: str) -> None:
    assert parse_origins(origin) == [origin]


def test_importing_the_module_has_no_side_effects() -> None:
    import app.main as m

    assert not hasattr(m, "app")  # served with `uvicorn app.main:create_app --factory`
