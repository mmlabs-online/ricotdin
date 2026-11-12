from fastapi.testclient import TestClient

from app.core.settings import Settings
from app.main import create_app


def test_health_returns_ok_without_dependencies() -> None:
    # /health must not touch the DB or any provider (image HEALTHCHECK).
    response = TestClient(create_app(Settings())).get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
