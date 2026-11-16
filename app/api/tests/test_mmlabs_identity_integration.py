# ruff: noqa: F811 - pytest fixtures imported from the storage route tests are parameters here
"""AUT-05: the API accepts mmlabs access tokens end to end (scratch database, the real API, a test
JWKS). First sign-in links by email or creates a user; a linked user is never taken over; the
admin role follows the token; ricotdin-disabled users are refused; roles are not editable here."""

import asyncio
import json
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from app.auth.mmlabs import MmlabsVerifier
from tests.conftest import requires_db
from tests.fake_drive import FakeDrive  # noqa: F401
from tests.test_meetings_storage_integration import (  # noqa: F401 - fixtures
    _sql,
    _user,
    client,
    drive,
    world,
)

pytestmark = requires_db

ISS = "https://api.mmlabs.online"
KEY = ec.generate_private_key(ec.SECP256R1())
JWK = {**json.loads(pyjwt.algorithms.ECAlgorithm.to_jwk(KEY.public_key())), "kid": "t1"}


async def _jwks() -> dict[str, Any]:
    return {"keys": [JWK]}


@pytest.fixture
def mm(client: TestClient) -> TestClient:
    app: Any = client.app
    app.state.mmlabs = MmlabsVerifier(ISS, "ricotdin", _jwks)
    return client


def _bearer(sub: str, email: str, roles: list[str] | None = None, **over: Any) -> dict[str, str]:
    now = datetime.now(UTC)
    payload = {"iss": ISS, "aud": "ricotdin", "sub": sub, "email": email, "email_verified": True,
               "roles": roles or ["ricotdin:member"], "iat": now,
               "exp": now + timedelta(minutes=15), "jti": secrets.token_hex(8), **over}  # fmt: skip
    tok = pyjwt.encode(payload, KEY, algorithm="ES256", headers={"typ": "at+jwt", "kid": "t1"})
    return {"Authorization": f"Bearer {tok}"}


def _email_of(world: dict[str, Any], uid: uuid.UUID) -> str:
    return str(_sql(world["db"], "SELECT email FROM users WHERE id = %s", uid)[0][0])


def test_first_sign_in_links_the_existing_account_by_email(
    mm: TestClient, world: dict[str, Any]
) -> None:
    uid = _user(world["db"], f"link{secrets.token_hex(3)}")
    sub = str(uuid.uuid4())
    r = mm.get("/auth/me", headers=_bearer(sub, _email_of(world, uid).upper()))
    assert r.status_code == 200, r.text
    assert r.json()["id"] == str(uid)
    assert _sql(world["db"], "SELECT mmlabs_sub FROM users WHERE id = %s", uid) == [(sub,)]
    # later requests use the stored link, even when the mmlabs email changed
    assert mm.get("/auth/me", headers=_bearer(sub, "renamed@example.test")).json()["id"] == str(uid)


def test_a_linked_account_is_not_taken_over_by_another_sub(
    mm: TestClient, world: dict[str, Any]
) -> None:
    uid = _user(world["db"], f"take{secrets.token_hex(3)}")
    email = _email_of(world, uid)
    assert mm.get("/auth/me", headers=_bearer(str(uuid.uuid4()), email)).status_code == 200
    r = mm.get("/auth/me", headers=_bearer(str(uuid.uuid4()), email))
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "account_link_conflict"


def test_a_new_mmlabs_account_gets_a_user_and_a_profile(
    mm: TestClient, world: dict[str, Any]
) -> None:
    tag = secrets.token_hex(3)
    _user(world["db"], f"fresh{tag}")  # takes the base username
    sub = str(uuid.uuid4())
    r = mm.get("/auth/me", headers=_bearer(sub, f"Fresh{tag}@Elsewhere.test"))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["email"] == f"fresh{tag}@elsewhere.test"
    assert body["username"] == f"fresh{tag}-2"
    assert body["role"] == "user"
    row = _sql(world["db"], "SELECT u.mmlabs_sub, u.password_hash, u.email_verified_at IS NOT NULL, "
               "p.role FROM users u JOIN profiles p ON p.id = u.id WHERE u.id = %s",
               uuid.UUID(body["id"]))  # fmt: skip
    assert row == [(sub, None, True, "user")]


def test_the_admin_role_follows_the_token(mm: TestClient, world: dict[str, Any]) -> None:
    uid = _user(world["db"], f"adm{secrets.token_hex(3)}")
    sub, email = str(uuid.uuid4()), _email_of(world, uid)
    admin = _bearer(sub, email, ["ricotdin:member", "ricotdin:admin"])
    assert mm.get("/admin/users", headers=admin).status_code == 200
    assert _sql(world["db"], "SELECT role FROM users WHERE id = %s", uid) == [("admin",)]
    plain = _bearer(sub, email)
    assert mm.get("/admin/users", headers=plain).status_code == 403
    assert _sql(world["db"], "SELECT role FROM users WHERE id = %s", uid) == [("user",)]
    assert _sql(world["db"], "SELECT role FROM profiles WHERE id = %s", uid) == [("user",)]


def test_a_ricotdin_disabled_user_is_refused(mm: TestClient, world: dict[str, Any]) -> None:
    uid = _user(world["db"], f"dis{secrets.token_hex(3)}")
    _sql(world["db"], "UPDATE users SET disabled_at = now() WHERE id = %s", uid)
    r = mm.get("/auth/me", headers=_bearer(str(uuid.uuid4()), _email_of(world, uid)))
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "account_disabled"


def test_roles_are_managed_in_mmlabs(mm: TestClient, world: dict[str, Any]) -> None:
    uid = _user(world["db"], f"rol{secrets.token_hex(3)}")
    target = _user(world["db"], f"tgt{secrets.token_hex(3)}")
    admin = _bearer(str(uuid.uuid4()), _email_of(world, uid), ["ricotdin:admin"])
    r = mm.patch(f"/admin/users/{target}/role", headers=admin, json={"role": "admin"})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "role_managed_externally"


@pytest.mark.parametrize(
    "over", [{"aud": "admin"}, {"iss": "https://evil.test"}, {"email_verified": False}]
)
def test_bad_mmlabs_tokens_get_401(mm: TestClient, over: dict[str, Any]) -> None:
    assert (
        mm.get("/auth/me", headers=_bearer(str(uuid.uuid4()), "x@y.test", **over)).status_code
        == 401
    )


def test_concurrent_first_sign_ins_create_one_user(mm: TestClient, world: dict[str, Any]) -> None:
    sub, email = str(uuid.uuid4()), f"race{secrets.token_hex(3)}@example.test"

    async def both() -> list[int]:
        loop = asyncio.get_running_loop()
        calls = [loop.run_in_executor(None, lambda: mm.get("/auth/me", headers=_bearer(sub, email)))
                 for _ in range(2)]  # fmt: skip
        return [r.status_code for r in await asyncio.gather(*calls)]

    assert asyncio.run(both()) == [200, 200]
    assert _sql(world["db"], "SELECT count(*) FROM users WHERE mmlabs_sub = %s", sub) == [(1,)]
