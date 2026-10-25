from fastapi.testclient import TestClient

from app.main import app


def test_health_returns_ok_without_dependencies() -> None:
    # ARC-00 skeleton: /health must not touch the DB or any provider (image HEALTHCHECK).
    response = TestClient(app).get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
