"""ARC-04: the assembled FastAPI app — health, version, CORS, error mapping, security headers.

No database: the app must start and answer these without DATABASE_URL_* (health never touches
the DB or a provider).
"""

import logging

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from app.core.errors import NotFound
from app.core.settings import Settings
from app.main import create_app

ORIGIN = "https://app.ricotdin.test"


def _client(**env: str) -> TestClient:
    settings = Settings.model_validate({"ALLOWED_ORIGINS": ORIGIN, **env})
    app = create_app(settings)
    router = APIRouter()

    @router.get("/boom/domain")
    def domain() -> None:
        raise NotFound(
            "Meeting not found.", detail="meeting m1 of user u2 via postgresql://u:pw@h/db"
        )

    @router.get("/boom/crash")
    def crash() -> None:
        raise RuntimeError("password=hunter2 in a stack")

    app.include_router(router)
    return TestClient(app, raise_server_exceptions=False)


def test_health_is_ok_without_any_database() -> None:
    r = _client().get("/health")
    assert (r.status_code, r.json()) == (200, {"status": "ok"})


def test_version_json(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RICOTDIN_VERSION", "v2.0.0-test")
    r = _client().get("/version.json")
    assert (r.status_code, r.json()) == (200, {"version": "v2.0.0-test"})


def test_allowed_origin_gets_cors_headers() -> None:
    r = _client().get("/health", headers={"Origin": ORIGIN})
    assert r.headers.get("access-control-allow-origin") == ORIGIN
    assert r.headers.get("access-control-allow-credentials") == "true"


def test_other_origin_gets_no_cors_headers() -> None:
    r = _client().get("/health", headers={"Origin": "https://evil.test"})
    assert "access-control-allow-origin" not in r.headers


def test_preflight_from_other_origin_is_refused() -> None:
    r = _client().options(
        "/health",
        headers={"Origin": "https://evil.test", "Access-Control-Request-Method": "POST"},
    )
    assert "access-control-allow-origin" not in r.headers


def test_domain_error_is_mapped_and_detail_only_in_logs(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="ricotdin"):
        r = _client().get("/boom/domain")
    assert r.status_code == 404
    assert r.json() == {"error": {"code": "not_found", "message": "Meeting not found."}}
    logged = " ".join(rec.getMessage() for rec in caplog.records)
    assert "meeting m1 of user u2" in logged
    assert "pw@" not in logged  # redacted


def test_unexpected_error_is_a_generic_500_and_redacted_in_logs(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.ERROR, logger="ricotdin"):
        r = _client().get("/boom/crash")
    assert r.status_code == 500
    assert r.json()["error"]["code"] == "internal"
    assert "hunter2" not in r.text
    assert "hunter2" not in " ".join(rec.getMessage() for rec in caplog.records)


def test_security_headers_on_every_response() -> None:
    r = _client().get("/health")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"
    assert r.headers["referrer-policy"] == "no-referrer"
    assert "strict-transport-security" in r.headers


def test_openapi_lists_the_core_routes() -> None:
    paths = _client().get("/openapi.json").json()["paths"]
    assert "/health" in paths and "/version.json" in paths
