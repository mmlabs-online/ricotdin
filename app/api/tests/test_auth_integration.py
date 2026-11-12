"""ARC-05: the auth endpoints end to end against a scratch database (CLAUDE.md §0.1).

Real runtime logins (``ricotdin_test_*``) for ricotdin_app and ricotdin_service, a generated
Ed25519 key and an in-memory mailer that captures the links.
"""

import secrets
from collections.abc import Iterator
from dataclasses import fields
from typing import Any

import bcrypt
import psycopg
import pytest
from fastapi.testclient import TestClient

from app.auth.cookies import REFRESH_COOKIE
from app.auth.jwt import generate_private_pem
from app.auth.runtime import Limiters
from app.core.ratelimit import RateLimiter
from app.core.settings import Settings
from app.db.provision import drop_login, ensure_login
from app.db.scratch import admin_url, scratch_database
from app.email.sender import MemoryMailer
from app.main import create_app
from tests.conftest import alembic_upgrade, requires_db

pytestmark = requires_db

WEB = "https://app.ricotdin.test"
PASSWORD = "correct horse battery"


@pytest.fixture(scope="module")
def env() -> Iterator[dict[str, Any]]:
    suffix = secrets.token_hex(3)
    owner = admin_url()
    with scratch_database("auth") as url:
        alembic_upgrade(url)
        app_login = ensure_login(
            owner, "ricotdin_app", f"ricotdin_test_api_{suffix}", connection_limit=5
        )
        svc_login = ensure_login(
            owner, "ricotdin_service", f"ricotdin_test_svc_{suffix}", connection_limit=5
        )
        try:
            yield {"db": url, "app": app_login.url(url), "service": svc_login.url(url)}
        finally:
            drop_login(owner, app_login.name)
            drop_login(owner, svc_login.name)


@pytest.fixture
def api(
    env: dict[str, Any], request: pytest.FixtureRequest
) -> Iterator[tuple[TestClient, MemoryMailer]]:
    settings = Settings.model_validate(
        {
            "DATABASE_URL_APP": env["app"],
            "DATABASE_URL_SERVICE": env["service"],
            "JWT_PRIVATE_KEY": generate_private_pem(),
            "WEB_ORIGIN": WEB,
        }
    )
    settings.db_pool_app = (2, 0)
    settings.db_pool_service = (2, 0)
    app = create_app(settings)
    mailer = MemoryMailer()
    app.state.auth.mailer = mailer
    if not request.node.get_closest_marker("real_limits"):
        app.state.auth.limiters = Limiters(*(_unlimited() for _ in fields(Limiters)))
    with TestClient(app, base_url="https://api.ricotdin.test") as client:
        yield client, mailer


def _unlimited() -> RateLimiter:
    return RateLimiter(capacity=100_000, refill_per_second=1_000)


def _sql(env: dict[str, Any], query: str, *args: Any) -> list[tuple[Any, ...]]:
    with psycopg.connect(env["db"], autocommit=True) as conn:
        cur = conn.execute(query, args)
        return cur.fetchall() if cur.description else []


def _token_from(mailer: MemoryMailer, to: str) -> str:
    msg = [m for m in mailer.outbox if m.to == to][-1]
    return msg.text.split("#token=", 1)[1].split()[0]


def _new_name() -> str:
    return "u" + secrets.token_hex(4)


def _register(client: TestClient, name: str, password: str = PASSWORD) -> Any:
    return client.post(
        "/auth/register",
        json={"email": f"{name.upper()}@Example.test", "username": name, "password": password},
    )


def _verified_user(client: TestClient, mailer: MemoryMailer) -> str:
    name = _new_name()
    assert _register(client, name).status_code == 201
    r = _verify(client, _token_from(mailer, f"{name}@example.test"))
    assert r.status_code == 200, r.text
    return name


def _verify(client: TestClient, token: str, password: str = PASSWORD) -> Any:
    """SEC-05: the verify link also sets the password."""
    return client.post("/auth/verify-email", json={"token": token, "password": password})


def _login(
    client: TestClient, identifier: str, password: str = PASSWORD, origin: str | None = WEB
) -> Any:
    headers = {"Origin": origin} if origin else {}
    return client.post(
        "/auth/login", headers=headers, json={"identifier": identifier, "password": password}
    )


def _refresh(client: TestClient, origin: str | None = WEB) -> Any:
    headers = {"Origin": origin} if origin else {}
    return client.post("/auth/refresh", headers=headers)


# --- register / verify ---------------------------------------------------------------------


def test_register_creates_user_profile_quota_and_sends_verification(api: Any, env: Any) -> None:
    client, mailer = api
    name = _new_name()
    r = _register(client, name)
    assert r.status_code == 201, r.text
    assert r.json() == {"verify_email": True, "email_sent": True}
    rows = _sql(
        env,
        "SELECT u.email, u.role, u.email_verified_at, p.username, p.role, u.password_hash "
        "FROM users u JOIN profiles p ON p.id = u.id WHERE p.username = %s",
        name,
    )
    email, role, verified, username, profile_role, pw_hash = rows[0]
    assert (email, role, verified, username, profile_role) == (
        f"{name}@example.test", "user", None, name, "user",
    )  # fmt: skip
    assert pw_hash.startswith("$argon2id$")
    wallet = _sql(
        env,
        "SELECT audio_seconds_remaining, agent_queries_remaining FROM quota_wallets w "
        "JOIN profiles p ON p.id = w.user_id WHERE p.username = %s",
        name,
    )
    assert wallet == [(3600, 50)]
    assert "#token=" in mailer.outbox[-1].text


def test_client_cannot_choose_a_role(api: Any, env: Any) -> None:
    client, _ = api
    name = _new_name()
    r = client.post(
        "/auth/register",
        json={
            "email": f"{name}@example.test",
            "username": name,
            "password": PASSWORD,
            "role": "admin",
        },
    )
    assert r.status_code == 201
    assert _sql(env, "SELECT role FROM profiles WHERE username = %s", name) == [("user",)]


@pytest.mark.parametrize(
    ("body", "fragment"),
    [
        ({"email": "bad", "username": "okname", "password": PASSWORD}, "valid email"),
        ({"email": "a@b.test", "username": "No Spaces", "password": PASSWORD}, "lowercase"),
        ({"email": "a@b.test", "username": "okname", "password": "short"}, "at least 8"),
    ],
)
def test_register_validation(api: Any, body: dict[str, str], fragment: str) -> None:
    client, _ = api
    r = client.post("/auth/register", json=body)
    assert r.status_code == 422 and fragment in r.json()["error"]["message"]


def test_duplicate_username_and_email_conflict(api: Any) -> None:
    client, mailer = api
    name = _verified_user(client, mailer)  # an unverified email no longer conflicts (SEC-05)
    other = _new_name()
    r = client.post(
        "/auth/register",
        json={"email": f"{other}@example.test", "username": name, "password": PASSWORD},
    )
    assert r.status_code == 409 and "username" in r.json()["error"]["message"]
    r = client.post(
        "/auth/register",
        json={"email": f"{name}@EXAMPLE.test", "username": other, "password": PASSWORD},
    )
    assert r.status_code == 409 and "email" in r.json()["error"]["message"]


def test_sec05_registering_an_unverified_email_resends_the_link(api: Any, env: Any) -> None:
    client, mailer = api
    name = _new_name()  # the "attacker" registers the address first, with their own password
    assert _register(client, name, password="attacker-pass-1").status_code == 201
    first = _token_from(mailer, f"{name}@example.test")
    # the inbox owner registers the same address with a free username: same answer as a new one
    mine = _new_name()
    r = client.post(
        "/auth/register",
        json={"email": f"{name}@example.test", "username": mine, "password": PASSWORD},
    )
    assert r.status_code == 201, r.text
    assert r.json() == {"verify_email": True, "email_sent": True}
    assert _sql(env, "SELECT count(*) FROM users WHERE email = %s", f"{name}@example.test") == [
        (1,)
    ]
    second = _token_from(mailer, f"{name}@example.test")
    assert first != second  # the earlier link is not cancelled: nobody can block the owner
    # the owner sets the password through the link: only that password signs in afterwards
    assert _verify(client, second, password="owner-pass-22").status_code == 200
    assert _verify(client, first).status_code == 400  # verified: no link works any more
    assert _login(client, mine, "attacker-pass-1").status_code == 401
    assert _login(client, mine, "owner-pass-22").status_code == 200  # the free username won
    assert _login(client, name, "owner-pass-22").status_code == 401  # the earlier one is gone


def test_sec05_reregistering_an_unverified_email_with_a_third_accounts_username(
    api: Any,
) -> None:
    client, mailer = api
    name, third = _new_name(), _verified_user(client, mailer)
    _register(client, name)
    r = client.post(
        "/auth/register",
        json={"email": f"{name}@example.test", "username": third, "password": PASSWORD},
    )
    assert r.status_code == 409 and "username" in r.json()["error"]["message"]


def test_sec05_a_verified_email_still_conflicts_even_with_its_own_username(api: Any) -> None:
    client, mailer = api
    name = _verified_user(client, mailer)
    r = _register(client, name)
    assert r.status_code == 409 and "email" in r.json()["error"]["message"]


def test_sec05_register_resends_are_limited_silently(api: Any) -> None:
    client, mailer = api
    app: Any = client.app
    app.state.auth.limiters.register_resend = RateLimiter(capacity=3, refill_per_second=3 / 3600)
    name = _new_name()
    _register(client, name)
    before = len(mailer.outbox)
    for _ in range(5):  # 3 per hour re-send; the rest answer the same and send nothing
        assert _register(client, name).status_code == 201
    assert len(mailer.outbox) - before == 3


def test_sec05_a_verify_link_never_resets_a_verified_account(api: Any, env: Any) -> None:
    client, mailer = api
    name = _new_name()
    _register(client, name)
    token = _token_from(mailer, f"{name}@example.test")
    _register(client, name)  # a second link
    assert _verify(client, _token_from(mailer, f"{name}@example.test")).status_code == 200
    assert _verify(client, token, password="takeover-pass-9").status_code == 400
    assert _login(client, name, "takeover-pass-9").status_code == 401


def test_sec05_reregistering_with_the_accounts_own_username_resends(api: Any) -> None:
    client, mailer = api
    name = _new_name()
    _register(client, name)
    first = _token_from(mailer, f"{name}@example.test")
    assert _register(client, name).status_code == 201  # lost the mail: register again
    assert _token_from(mailer, f"{name}@example.test") != first


def test_sec05_verify_needs_a_valid_password_and_keeps_the_token(api: Any, env: Any) -> None:
    client, mailer = api
    name = _new_name()
    _register(client, name)
    token = _token_from(mailer, f"{name}@example.test")
    assert _verify(client, token, password="short").status_code == 422
    r = client.post("/auth/verify-email", json={"token": token})
    assert r.status_code == 422
    assert _sql(
        env,
        "SELECT email_verified_at IS NULL FROM users u JOIN profiles p ON p.id = u.id "
        "WHERE p.username = %s",
        name,
    ) == [(True,)]
    assert _verify(client, token).status_code == 200  # still usable


def test_sec05_verify_revokes_existing_sessions(api: Any, env: Any) -> None:
    client, mailer = api
    name = _verified_user(client, mailer)
    _login(client, name)
    r = client.post("/auth/resend-verification", json={"email": f"{name}@example.test"})
    assert r.status_code == 202  # already verified: no new link
    _sql(
        env,
        "UPDATE users SET email_verified_at = NULL "
        "WHERE id = (SELECT id FROM profiles WHERE username = %s)",
        name,
    )
    client.post("/auth/resend-verification", json={"email": f"{name}@example.test"})
    assert _verify(client, _token_from(mailer, f"{name}@example.test")).status_code == 200
    assert _sql(
        env,
        "SELECT count(*) FROM refresh_tokens WHERE revoked_at IS NULL "
        "AND user_id = (SELECT id FROM profiles WHERE username = %s)",
        name,
    ) == [(0,)]


def test_verification_token_is_single_use(api: Any) -> None:
    client, mailer = api
    name = _new_name()
    _register(client, name)
    token = _token_from(mailer, f"{name}@example.test")
    assert _verify(client, token).status_code == 200
    r = _verify(client, token)
    assert r.status_code == 400


def test_resend_replaces_the_previous_link(api: Any) -> None:
    client, mailer = api
    name = _new_name()
    _register(client, name)
    first = _token_from(mailer, f"{name}@example.test")
    r = client.post("/auth/resend-verification", json={"email": f"{name}@example.test"})
    assert r.status_code == 202
    second = _token_from(mailer, f"{name}@example.test")
    assert first != second
    assert _verify(client, first).status_code == 400
    assert _verify(client, second).status_code == 200


def test_resend_for_unknown_email_looks_the_same(api: Any) -> None:
    client, mailer = api
    before = len(mailer.outbox)
    r = client.post("/auth/resend-verification", json={"email": "nobody@example.test"})
    assert r.status_code == 202
    assert len(mailer.outbox) == before


# --- login ---------------------------------------------------------------------------------


def test_unverified_user_gets_403_verify(api: Any) -> None:
    client, _ = api
    name = _new_name()
    _register(client, name)
    r = _login(client, name)
    assert r.status_code == 403 and "verify" in r.json()["error"]["message"].lower()


def test_unknown_identifier_and_wrong_password_look_the_same(api: Any) -> None:
    client, mailer = api
    name = _verified_user(client, mailer)
    unknown = _login(client, "nobody_here")
    wrong = _login(client, name, "wrong password")
    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json() == wrong.json()


def test_unverified_status_is_not_revealed_without_the_password(api: Any) -> None:
    client, _ = api
    name = _new_name()
    _register(client, name)
    assert _login(client, name, "wrong password").status_code == 401


def test_login_by_username_or_email_returns_token_and_cookie(api: Any, env: Any) -> None:
    client, mailer = api
    name = _verified_user(client, mailer)
    for ident in (name.upper(), f" {name}@EXAMPLE.test "):
        r = _login(client, ident)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["token_type"] == "bearer" and body["expires_in"] == 900
        assert body["user"]["username"] == name and body["user"]["role"] == "user"
        assert "refresh_token" not in body
        cookie = r.headers["set-cookie"]
        assert cookie.startswith(f"{REFRESH_COOKIE}=")
        for attr in ("HttpOnly", "Secure", "SameSite=lax", "Path=/auth"):
            assert attr.lower() in cookie.lower()
    events = _sql(
        env,
        "SELECT count(*) FROM activity_log a JOIN profiles p ON p.id = a.user_id "
        "WHERE p.username = %s AND a.event_type = 'login'",
        name,
    )
    assert events == [(2,)]


def test_migrated_bcrypt_hash_is_rehashed_on_login(api: Any, env: Any) -> None:
    client, mailer = api
    name = _verified_user(client, mailer)
    legacy = "$2a$" + bcrypt.hashpw(PASSWORD.encode(), bcrypt.gensalt(rounds=4)).decode()[4:]
    _sql(
        env,
        "UPDATE users SET password_hash = %s WHERE id = (SELECT id FROM profiles WHERE username = %s)",
        legacy,
        name,
    )
    assert _login(client, name).status_code == 200
    (stored,) = _sql(
        env,
        "SELECT password_hash FROM users WHERE id = (SELECT id FROM profiles WHERE username = %s)",
        name,
    )[0]
    assert stored.startswith("$argon2id$")
    assert _login(client, name).status_code == 200


def test_disabled_user_gets_403_disabled(api: Any, env: Any) -> None:
    client, mailer = api
    name = _verified_user(client, mailer)
    _sql(env, "UPDATE users SET disabled_at = now() WHERE email = %s", f"{name}@example.test")
    r = _login(client, name)
    assert r.status_code == 403 and "disabled" in r.json()["error"]["message"]


@pytest.mark.real_limits
def test_login_is_rate_limited_per_ip(api: Any) -> None:
    client, _ = api
    codes = [_login(client, f"nobody{i}", "wrong password").status_code for i in range(11)]
    assert codes[:10] == [401] * 10 and codes[10] == 429


# --- access token / identity ------------------------------------------------------------------


def test_me_needs_a_valid_bearer_token(api: Any) -> None:
    client, mailer = api
    name = _verified_user(client, mailer)
    assert client.get("/auth/me").status_code == 401
    assert client.get("/auth/me", headers={"Authorization": "Bearer nope"}).status_code == 401
    token = _login(client, name).json()["access_token"]
    r = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200 and r.json()["username"] == name


def test_jwks_is_public(api: Any) -> None:
    client, _ = api
    r = client.get("/.well-known/jwks.json")
    assert r.status_code == 200 and r.json()["keys"][0]["kty"] == "OKP"


# --- refresh -----------------------------------------------------------------------------------


def test_refresh_rotates_and_reuse_revokes_the_family(api: Any, env: Any) -> None:
    client, mailer = api
    name = _verified_user(client, mailer)
    _login(client, name)
    first = client.cookies.get(REFRESH_COOKIE)
    r = _refresh(client)
    assert r.status_code == 200, r.text
    assert r.json()["access_token"]
    second = client.cookies.get(REFRESH_COOKIE)
    assert second and second != first
    # Right after rotation the old token is a race (second tab / retry): 401, family intact.
    client.cookies.set(REFRESH_COOKIE, first, domain="api.ricotdin.test", path="/auth")
    raced = _refresh(client)
    assert raced.status_code == 401
    # ARC-11: the race answer must not delete the cookie — in a browser the jar is shared, so
    # clearing it would wipe the token the winning tab just received.
    assert "set-cookie" not in raced.headers
    client.cookies.set(REFRESH_COOKIE, second, domain="api.ricotdin.test", path="/auth")
    r = _refresh(client)
    assert r.status_code == 200
    third = client.cookies.get(REFRESH_COOKIE)
    # Later, the old token presented again is a stolen copy: the whole family dies.
    _sql(
        env,
        "UPDATE refresh_tokens SET revoked_at = now() - interval '1 minute' "
        "WHERE replaced_by IS NOT NULL",
    )
    client.cookies.set(REFRESH_COOKIE, first, domain="api.ricotdin.test", path="/auth")
    assert _refresh(client).status_code == 401
    client.cookies.set(REFRESH_COOKIE, third, domain="api.ricotdin.test", path="/auth")
    assert _refresh(client).status_code == 401
    live = _sql(
        env,
        "SELECT count(*) FROM refresh_tokens t JOIN profiles p ON p.id = t.user_id "
        "WHERE p.username = %s AND t.revoked_at IS NULL",
        name,
    )
    assert live == [(0,)]


def test_expired_refresh_token_is_refused_and_revoked(api: Any, env: Any) -> None:
    client, mailer = api
    name = _verified_user(client, mailer)
    _login(client, name)
    _sql(
        env,
        "UPDATE refresh_tokens SET expires_at = now() - interval '1 second' "
        "WHERE user_id = (SELECT id FROM profiles WHERE username = %s)",
        name,
    )
    assert _refresh(client).status_code == 401
    assert _sql(
        env,
        "SELECT count(*) FROM refresh_tokens WHERE revoked_at IS NULL "
        "AND user_id = (SELECT id FROM profiles WHERE username = %s)",
        name,
    ) == [(0,)]


def test_sec05_a_session_ends_90_days_after_sign_in(api: Any, env: Any) -> None:
    client, mailer = api
    name = _verified_user(client, mailer)
    _login(client, name)
    _sql(env, _AGE_FAMILY, "89 days", name)
    assert _refresh(client).status_code == 200  # inside 90 days: still refreshes
    # the new token never outlives the family: sign-in (89 days ago) + 90 days = tomorrow
    assert _sql(env, _ACTIVE_EXPIRES_WITHIN_A_DAY, name) == [(True,)]
    _sql(env, _AGE_FAMILY, "90 days 1 second", name)
    assert _refresh(client).status_code == 401
    assert _sql(env, _ACTIVE_COUNT, name) == [(0,)]


_AGE_FAMILY = (
    "UPDATE refresh_tokens SET created_at = now() - %s::interval "
    "WHERE user_id = (SELECT id FROM profiles WHERE username = %s)"
)
_ACTIVE_EXPIRES_WITHIN_A_DAY = (
    "SELECT expires_at <= now() + interval '1 day 5 seconds' FROM refresh_tokens "
    "WHERE revoked_at IS NULL AND user_id = (SELECT id FROM profiles WHERE username = %s)"
)
_ACTIVE_COUNT = (
    "SELECT count(*) FROM refresh_tokens "
    "WHERE revoked_at IS NULL AND user_id = (SELECT id FROM profiles WHERE username = %s)"
)


def test_login_and_logout_require_an_allowed_origin(api: Any) -> None:
    client, mailer = api
    name = _verified_user(client, mailer)
    assert _login(client, name, origin=None).status_code == 403
    assert _login(client, name, origin="https://evil.test").status_code == 403
    assert _login(client, name).status_code == 200
    assert client.post("/auth/logout").status_code == 403
    assert client.post("/auth/logout", headers={"Origin": "https://evil.test"}).status_code == 403


def test_expired_reset_link_is_refused(api: Any, env: Any) -> None:
    client, mailer = api
    name = _verified_user(client, mailer)
    client.post("/auth/forgot-password", json={"email": f"{name}@example.test"})
    token = _token_from(mailer, f"{name}@example.test")
    _sql(
        env,
        "UPDATE email_tokens SET expires_at = now() - interval '1 second' "
        "WHERE purpose = 'reset_password' AND used_at IS NULL",
    )
    r = client.post("/auth/reset-password", json={"token": token, "password": "brand new password"})
    assert r.status_code == 400
    assert _login(client, name).status_code == 200  # password unchanged


def test_refresh_requires_an_allowed_origin(api: Any) -> None:
    client, mailer = api
    _login(client, _verified_user(client, mailer))
    assert _refresh(client, origin=None).status_code == 403
    assert _refresh(client, origin="https://evil.test").status_code == 403
    assert _refresh(client).status_code == 200


def test_refresh_without_cookie_is_401(api: Any) -> None:
    client, _ = api
    client.cookies.clear()
    assert _refresh(client).status_code == 401


def test_disabled_user_refresh_fails_and_revokes_everything(api: Any, env: Any) -> None:
    client, mailer = api
    name = _verified_user(client, mailer)
    _login(client, name)
    other_session = TestClient(client.app, base_url="https://api.ricotdin.test")
    _login(other_session, name)
    _sql(env, "UPDATE users SET disabled_at = now() WHERE email = %s", f"{name}@example.test")
    assert _refresh(client).status_code == 401
    live = _sql(
        env,
        "SELECT count(*) FROM refresh_tokens t JOIN users u ON u.id = t.user_id "
        "WHERE u.email = %s AND t.revoked_at IS NULL",
        f"{name}@example.test",
    )
    assert live == [(0,)]


def test_role_change_shows_up_on_next_refresh(api: Any, env: Any) -> None:
    client, mailer = api
    name = _verified_user(client, mailer)
    _login(client, name)
    _sql(env, "UPDATE users SET role = 'admin' WHERE email = %s", f"{name}@example.test")
    r = _refresh(client)
    assert r.json()["user"]["role"] == "admin"
    assert _sql(env, "SELECT role FROM profiles WHERE username = %s", name) == [("admin",)]


def test_logout_revokes_the_session_and_clears_the_cookie(api: Any, env: Any) -> None:
    client, mailer = api
    name = _verified_user(client, mailer)
    _login(client, name)
    token = client.cookies.get(REFRESH_COOKIE)
    r = client.post("/auth/logout", headers={"Origin": WEB})
    assert r.status_code == 204
    assert "max-age=0" in r.headers["set-cookie"].lower()
    client.cookies.set(REFRESH_COOKIE, token, domain="api.ricotdin.test", path="/auth")
    assert _refresh(client).status_code == 401


# --- password reset / change -----------------------------------------------------------------


def test_forgot_and_reset_password(api: Any) -> None:
    client, mailer = api
    name = _verified_user(client, mailer)
    _login(client, name)
    old_refresh = client.cookies.get(REFRESH_COOKIE)
    assert (
        client.post("/auth/forgot-password", json={"email": f"{name}@example.test"}).status_code
        == 202
    )
    token = _token_from(mailer, f"{name}@example.test")
    assert "reset-password#token=" in mailer.outbox[-1].text
    r = client.post("/auth/reset-password", json={"token": token, "password": "short"})
    assert r.status_code == 422
    r = client.post("/auth/reset-password", json={"token": token, "password": "brand new password"})
    assert r.status_code == 200, r.text
    assert (
        client.post(
            "/auth/reset-password", json={"token": token, "password": "another one!"}
        ).status_code
        == 400
    )
    assert _login(client, name).status_code == 401
    assert _login(client, name, "brand new password").status_code == 200
    # Every session that existed before the reset is gone.
    client.cookies.set(REFRESH_COOKIE, old_refresh, domain="api.ricotdin.test", path="/auth")
    assert _refresh(client).status_code == 401


def test_forgot_password_for_unknown_email_looks_the_same(api: Any) -> None:
    client, mailer = api
    before = len(mailer.outbox)
    r = client.post("/auth/forgot-password", json={"email": "ghost@example.test"})
    assert r.status_code == 202 and len(mailer.outbox) == before


def test_change_password_needs_the_current_one(api: Any) -> None:
    client, mailer = api
    name = _verified_user(client, mailer)
    token = _login(client, name).json()["access_token"]
    auth = {"Authorization": f"Bearer {token}"}
    url = "/profile/change-password"
    r = client.post(
        url, headers=auth, json={"current_password": "wrong one!", "new_password": "x" * 12}
    )
    assert r.status_code == 403
    r = client.post(
        url, headers=auth, json={"current_password": PASSWORD, "new_password": PASSWORD}
    )
    assert r.status_code == 422
    r = client.post(url, json={"current_password": PASSWORD, "new_password": "x" * 12})
    assert r.status_code == 401
    r = client.post(
        url, headers=auth, json={"current_password": PASSWORD, "new_password": "x" * 12}
    )
    assert r.status_code == 200, r.text
    assert _login(client, name, "x" * 12).status_code == 200


def test_auth_tables_stay_unreadable_for_the_app_role(env: Any) -> None:
    with psycopg.connect(env["app"]) as conn:
        conn.execute("SET ROLE ricotdin_app")
        for table in ("users", "refresh_tokens", "email_tokens"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                conn.execute(f"SELECT 1 FROM {table}")  # noqa: S608 - fixed names
            conn.rollback()
            conn.execute("SET ROLE ricotdin_app")
