"""AUT-06: ricotdin's own password / JWT / refresh / email auth is gone; mmlabs is the only way in.
Pure: builds the app without starting it (no database, no network)."""

from fastapi.testclient import TestClient

from app.core.settings import Settings
from app.main import create_app

REMOVED = [
    ("POST", "/auth/register"),
    ("POST", "/auth/login"),
    ("POST", "/auth/refresh"),
    ("POST", "/auth/logout"),
    ("POST", "/auth/verify-email"),
    ("POST", "/auth/resend-verification"),
    ("POST", "/auth/forgot-password"),
    ("POST", "/auth/reset-password"),
    ("POST", "/profile/change-password"),
    ("GET", "/.well-known/jwks.json"),
    ("POST", "/admin/users/{user_id}/reset-password"),
]


def _routes() -> set[tuple[str, str]]:
    """Every documented route (included routers are wrapped, so read the OpenAPI document)."""
    app = create_app(Settings.model_validate({"WEB_ORIGIN": "https://app.ricotdin.test"}))
    paths = app.openapi()["paths"]
    return {(method.upper(), path) for path, ops in paths.items() for method in ops}


def test_the_legacy_auth_routes_are_gone() -> None:
    routes = _routes()
    assert [r for r in REMOVED if r in routes] == []


def test_the_legacy_auth_routes_answer_404() -> None:
    # not only undocumented: nothing answers them (no lifespan, so nothing touches a database)
    app = create_app(Settings.model_validate({"WEB_ORIGIN": "https://app.ricotdin.test"}))
    client = TestClient(app)
    for method, path in REMOVED:
        url = path.format(user_id="00000000-0000-0000-0000-000000000001")
        assert client.request(method, url, json={}).status_code in (404, 405), (method, path)


def test_the_ricotdin_user_lookup_stays() -> None:
    assert ("GET", "/auth/me") in _routes()


def test_legacy_auth_settings_are_no_longer_read() -> None:
    s = Settings.model_validate(
        {"JWT_PRIVATE_KEY": "x", "SMTP_HOST": "smtp.example.com", "REFRESH_TTL_DAYS": "3"}
    )
    for name in ("jwt_private_key", "jwt_previous_public_key", "refresh_ttl_days", "smtp_host",
                 "smtp_port", "smtp_user", "smtp_password", "mail_from"):  # fmt: skip
        assert not hasattr(s, name), name


def test_the_app_starts_without_a_jwt_key_or_smtp() -> None:
    app = create_app(Settings.model_validate({}))
    assert not hasattr(app.state, "auth")
