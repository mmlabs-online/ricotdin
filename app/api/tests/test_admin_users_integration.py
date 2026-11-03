# ruff: noqa: F811 - pytest fixtures imported from the storage route tests are parameters here
"""ARC-10a: ``/admin/users*`` end to end (scratch database, the real API, fake Drive). Non-admins
and stale admin tokens get 403; self / last-admin guards; disable revokes sessions; delete removes
the Drive files first; every mutation writes exactly one audit row without content."""

import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.auth.jwt import issue_access_token
from tests.conftest import requires_db
from tests.fake_drive import FakeDrive
from tests.test_meetings_storage_integration import (  # noqa: F401 - fixtures
    _as,
    _msg,
    _sql,
    _upload,
    _user,
    client,
    drive,
    world,
)

pytestmark = requires_db


def _token(client: TestClient, uid: uuid.UUID, role: str) -> dict[str, str]:
    app: Any = client.app
    return {"Authorization": f"Bearer {issue_access_token(app.state.auth.keys, uid, role)}"}


@pytest.fixture
def admin(client: TestClient, world: dict[str, Any]) -> dict[str, str]:
    """User ``a`` as an admin (DB role + token)."""
    _sql(world["db"], "UPDATE users SET role = 'admin', disabled_at = NULL WHERE id = %s",
         world["a"])  # fmt: skip
    return _token(client, world["a"], "admin")


def _new_user(world: dict[str, Any], role: str = "user") -> uuid.UUID:
    uid = _user(world["db"], f"adm{secrets.token_hex(4)}")
    if role != "user":
        _sql(world["db"], "UPDATE users SET role = %s WHERE id = %s", role, uid)
    return uid


def _audits(world: dict[str, Any], target: uuid.UUID) -> list[tuple[Any, ...]]:
    return _sql(world["db"], "SELECT action, actor_id, metadata FROM audit_logs WHERE "
                "target_id = %s ORDER BY created_at", str(target))  # fmt: skip


ROUTES = [
    ("GET", "/admin/users"), ("GET", "/admin/users/{id}"), ("PATCH", "/admin/users/{id}/role"),
    ("PATCH", "/admin/users/{id}/status"), ("POST", "/admin/users/{id}/reset-password"),
    ("DELETE", "/admin/users/{id}"), ("POST", "/admin/users/bulk"),
    ("GET", "/admin/users/{id}/quota"), ("POST", "/admin/users/{id}/quota"),
]  # fmt: skip


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_non_admins_and_stale_admin_tokens_get_403(
    client: TestClient, world: dict[str, Any], admin: dict[str, str], method: str, path: str
) -> None:
    target = _new_user(world)
    url = path.format(id=target)
    body = {"role": "admin", "disabled": True, "ids": [str(target)], "action": "disable",
            "agent_queries": 1}  # fmt: skip
    kw: dict[str, Any] = {"json": body} if method in ("PATCH", "POST") else {}
    assert client.request(method, url, headers=_as(client, "b"), **kw).status_code == 403
    assert client.request(method, url, **kw).status_code == 401
    # an admin token whose account was demoted or disabled since it was issued
    demoted = _new_user(world)
    assert client.request(method, url, headers=_token(client, demoted, "admin"),
                          **kw).status_code == 403  # fmt: skip
    disabled = _new_user(world, "admin")
    _sql(world["db"], "UPDATE users SET disabled_at = now() WHERE id = %s", disabled)
    assert client.request(method, url, headers=_token(client, disabled, "admin"),
                          **kw).status_code == 403  # fmt: skip
    assert _audits(world, target) == []
    assert _sql(world["db"], "SELECT role, disabled_at FROM users WHERE id = %s", target) == [
        ("user", None)
    ]


# --- list + detail ---------------------------------------------------------------------------------


def test_list_search_paging_and_usage(
    client: TestClient, world: dict[str, Any], admin: dict[str, str]
) -> None:
    uid = _new_user(world)
    name = _sql(world["db"], "SELECT username FROM profiles WHERE id = %s", uid)[0][0]
    _sql(world["db"], "INSERT INTO meetings (user_id, status) VALUES (%s, 'done')", uid)
    _sql(world["db"], "INSERT INTO usage_log (provider, model, operation, unit, quantity, "
         "total_tokens, user_id, status) VALUES ('openai', 'gpt-4o', 'chat', 'tokens', 7, 7, %s, "
         "'ok'), ('speechmatics', 'x', 'transcribe', 'audio_seconds', 3.5, NULL, %s, 'ok')",
         uid, uid)  # fmt: skip
    _sql(world["db"], "UPDATE usage_log SET audio_seconds = 3.5 WHERE user_id = %s AND "
         "unit = 'audio_seconds'", uid)  # fmt: skip
    r = client.get(f"/admin/users?search={name.upper()}", headers=admin)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 1 and body["page"] == 1 and body["perPage"] == 20
    (row,) = body["users"]
    assert row["id"] == str(uid) and row["status"] == "active" and row["role"] == "user"
    assert (row["meeting_count"], row["gemini_tokens"], row["audio_seconds"]) == (1, 7, 3.5)
    assert set(row) >= {"email", "username", "disabled", "email_confirmed", "created_at",
                        "last_sign_in_at"} and "password_hash" not in row  # fmt: skip
    last_year = client.get(f"/admin/users?search={name}&month=2001-01", headers=admin).json()
    assert last_year["month"] == "2001-01" and last_year["users"][0]["gemini_tokens"] == 0
    # wildcards are literal
    assert client.get("/admin/users?search=%25", headers=admin).json()["total"] == 0
    paged = client.get("/admin/users?perPage=1&page=2", headers=admin).json()
    assert len(paged["users"]) == 1 and paged["total"] >= 2


def test_detail(client: TestClient, world: dict[str, Any], admin: dict[str, str]) -> None:
    uid = _new_user(world)
    _sql(world["db"], "UPDATE users SET email_verified_at = NULL WHERE id = %s", uid)
    r = client.get(f"/admin/users/{uid}", headers=admin)
    assert r.status_code == 200 and r.json()["status"] == "unverified"
    assert r.json()["meeting_count"] == 0
    assert client.get(f"/admin/users/{uuid.uuid4()}", headers=admin).status_code == 404
    assert client.get("/admin/users/nope", headers=admin).status_code == 404


# --- role ----------------------------------------------------------------------------------------


def test_role_change_and_guards(
    client: TestClient, world: dict[str, Any], admin: dict[str, str]
) -> None:
    uid = _new_user(world)
    r = client.patch(f"/admin/users/{uid}/role", headers=admin, json={"role": "admin"})
    assert r.json() == {"ok": True, "role": "admin"}
    assert _sql(world["db"], "SELECT u.role, p.role FROM users u JOIN profiles p ON p.id = u.id "
                "WHERE u.id = %s", uid) == [("admin", "admin")]  # fmt: skip
    assert client.patch(f"/admin/users/{uid}/role", headers=admin,
                        json={"role": "user"}).status_code == 200  # fmt: skip
    audits = _audits(world, uid)
    assert [a[0] for a in audits] == ["user.role_change"] * 2
    assert audits[0][1] == world["a"] and audits[0][2] == {"from": "user", "to": "admin"}
    me = client.patch(f"/admin/users/{world['a']}/role", headers=admin, json={"role": "user"})
    assert me.status_code == 400 and _msg(me) == "You cannot demote yourself."
    bad = client.patch(f"/admin/users/{uid}/role", headers=admin, json={"role": "owner"})
    assert bad.status_code == 422
    assert client.patch(f"/admin/users/{uuid.uuid4()}/role", headers=admin,
                        json={"role": "user"}).status_code == 404  # fmt: skip


def test_the_last_admin_cannot_be_removed(
    client: TestClient, world: dict[str, Any], admin: dict[str, str]
) -> None:
    # Every other admin row is disabled: only `a` is an active admin.
    _sql(world["db"], "UPDATE users SET disabled_at = now() WHERE role = 'admin' AND id <> %s",
         world["a"])  # fmt: skip
    for method, path, body in (("PATCH", "role", {"role": "user"}),
                               ("PATCH", "status", {"disabled": True}), ("DELETE", "", None)):  # fmt: skip
        url = f"/admin/users/{world['a']}/{path}".rstrip("/")
        r = client.request(method, url, headers=admin, json=body)
        assert r.status_code == 400, (path, r.text)
    assert _sql(world["db"], "SELECT role, disabled_at FROM users WHERE id = %s",
                world["a"]) == [("admin", None)]  # fmt: skip


# --- status ---------------------------------------------------------------------------------------


def test_disable_revokes_sessions_and_enable_restores(
    client: TestClient, world: dict[str, Any], admin: dict[str, str]
) -> None:
    uid = _new_user(world)
    _sql(world["db"], "INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) "
         "VALUES (%s, gen_random_uuid(), %s, %s)", uid, secrets.token_hex(16),
         datetime.now(UTC) + timedelta(days=1))  # fmt: skip
    r = client.patch(f"/admin/users/{uid}/status", headers=admin, json={"disabled": True})
    assert r.json() == {"ok": True, "disabled": True}
    assert _sql(world["db"], "SELECT count(*) FROM refresh_tokens WHERE user_id = %s AND "
                "revoked_at IS NULL", uid) == [(0,)]  # fmt: skip
    assert client.get(f"/admin/users/{uid}", headers=admin).json()["status"] == "disabled"
    assert client.patch(f"/admin/users/{uid}/status", headers=admin,
                        json={"disabled": False}).status_code == 200  # fmt: skip
    assert _sql(world["db"], "SELECT disabled_at FROM users WHERE id = %s", uid) == [(None,)]
    assert [a[0] for a in _audits(world, uid)] == ["user.disable", "user.enable"]
    me = client.patch(f"/admin/users/{world['a']}/status", headers=admin, json={"disabled": True})
    assert _msg(me) == "You cannot disable your own account."
    assert client.patch(f"/admin/users/{uid}/status", headers=admin,
                        json={"disabled": "yes"}).status_code == 422  # fmt: skip


# --- reset password ------------------------------------------------------------------------------


def test_reset_password_issues_a_token_and_audits(
    client: TestClient, world: dict[str, Any], admin: dict[str, str]
) -> None:
    uid = _new_user(world)
    r = client.post(f"/admin/users/{uid}/reset-password", headers=admin)
    assert r.status_code == 200 and r.json() == {"ok": True, "email_sent": False}  # no SMTP here
    assert _sql(world["db"], "SELECT purpose FROM email_tokens WHERE user_id = %s", uid) == [
        ("reset_password",)
    ]
    assert [a[0] for a in _audits(world, uid)] == ["user.password_reset"]
    assert client.post(f"/admin/users/{uuid.uuid4()}/reset-password",
                       headers=admin).status_code == 404  # fmt: skip


# --- delete ---------------------------------------------------------------------------------------


def test_delete_removes_drive_files_first_then_the_user(
    client: TestClient, world: dict[str, Any], admin: dict[str, str], drive: FakeDrive
) -> None:
    mid, fid = _upload(client, drive, "d")
    r = client.delete(f"/admin/users/{world['d']}", headers=admin)
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "deleted": str(world["d"])}
    assert fid in drive.deleted
    assert _sql(world["db"], "SELECT count(*) FROM users WHERE id = %s", world["d"]) == [(0,)]
    assert _sql(world["db"], "SELECT count(*) FROM meetings WHERE id = %s", mid) == [(0,)]
    ((action, actor, meta),) = _audits(world, world["d"])
    assert (action, actor) == ("user.delete", world["a"])
    assert meta == {"meetings": 1, "files": 1, "files_failed": 0}
    assert client.delete(f"/admin/users/{world['d']}", headers=admin).status_code == 404
    me = client.delete(f"/admin/users/{world['a']}", headers=admin)
    assert _msg(me) == "You cannot delete your own account."


def test_delete_with_a_storage_failure_still_deletes(
    client: TestClient, world: dict[str, Any], admin: dict[str, str], drive: FakeDrive
) -> None:
    uid = _new_user(world)
    key = f"{uid}/{uuid.uuid4()}.webm"
    _sql(world["db"], "INSERT INTO meetings (id, user_id, status, audio_path) VALUES (%s, %s, "
         "'done', %s)", key.split("/")[1].split(".")[0], uid, key)  # fmt: skip
    _sql(world["db"], "INSERT INTO storage_objects (key, file_id, size_bytes, content_type) "
         "VALUES (%s, %s, 3, 'audio/webm')", key, f"f{secrets.token_hex(6)}")  # fmt: skip
    drive.fail = [500] * 5
    try:
        r = client.delete(f"/admin/users/{uid}", headers=admin)
    finally:
        drive.fail = []
    assert r.status_code == 200
    assert r.json()["storageWarnings"] == ["Storage cleanup failed for 1 file(s)."]
    assert _sql(world["db"], "SELECT count(*) FROM users WHERE id = %s", uid) == [(0,)]


# --- bulk -----------------------------------------------------------------------------------------


def test_bulk_skips_self_and_reports_unknown_ids(
    client: TestClient, world: dict[str, Any], admin: dict[str, str]
) -> None:
    u1, u2, ghost = _new_user(world), _new_user(world), uuid.uuid4()
    body = {"ids": [str(u1), str(u2), str(world["a"]), str(ghost)], "action": "disable"}
    r = client.post("/admin/users/bulk", headers=admin, json=body)
    assert r.status_code == 200, r.text
    assert r.json() == {"processed": 2, "errors": [{"id": str(ghost), "message": "User not found."}],
                        "skippedSelf": [str(world["a"])]}  # fmt: skip
    assert _sql(world["db"], "SELECT count(*) FROM users WHERE id IN (%s, %s) AND disabled_at IS "
                "NOT NULL", u1, u2) == [(2,)]  # fmt: skip
    assert _sql(world["db"], "SELECT disabled_at FROM users WHERE id = %s", world["a"]) == [(None,)]
    ((action, meta),) = _sql(world["db"], "SELECT action, metadata FROM audit_logs WHERE "
                             "metadata->'ids' ? %s", str(u1))  # fmt: skip
    assert action == "user.bulk_disable" and meta["processed"] == 2
    enable = client.post("/admin/users/bulk", headers=admin,
                         json={"ids": [str(u1)], "action": "enable"})  # fmt: skip
    assert enable.json() == {"processed": 1}
    role = client.post("/admin/users/bulk", headers=admin,
                       json={"ids": [str(u1)], "action": "set_role", "role": "admin"})  # fmt: skip
    assert role.json() == {"processed": 1}
    assert client.post("/admin/users/bulk", headers=admin,
                       json={"ids": [], "action": "enable"}).status_code == 422  # fmt: skip
    only_me = client.post("/admin/users/bulk", headers=admin,
                          json={"ids": [str(world["a"])], "action": "disable"})  # fmt: skip
    assert only_me.json() == {"processed": 0, "skippedSelf": [str(world["a"])]}


# --- quota ----------------------------------------------------------------------------------------


def test_quota_grant_and_history(
    client: TestClient, world: dict[str, Any], admin: dict[str, str]
) -> None:
    uid = _new_user(world)
    empty = client.get(f"/admin/users/{uid}/quota", headers=admin).json()
    assert empty == {"wallet": {"audio_seconds_remaining": 0, "agent_queries_remaining": 0,
                                "updated_at": None}, "ledger": []}  # fmt: skip
    r = client.post(f"/admin/users/{uid}/quota", headers=admin,
                    json={"audio_minutes": 2.5, "agent_queries": 4, "note": "trial"})  # fmt: skip
    assert r.status_code == 200, r.text
    assert (r.json()["audioRemaining"], r.json()["agentRemaining"]) == (150, 4)
    got = client.get(f"/admin/users/{uid}/quota", headers=admin).json()
    assert got["wallet"]["audio_seconds_remaining"] == 150
    (entry,) = got["ledger"]
    assert entry["reason"] == "admin_grant" and entry["created_by"] == str(world["a"])
    assert entry["metadata"]["note"] == "trial"
    ((action, _, meta),) = _audits(world, uid)
    assert action == "quota.grant" and meta["agent_queries"] == 4
    assert client.post(f"/admin/users/{uid}/quota", headers=admin,
                       json={"audio_minutes": -1}).status_code == 400  # fmt: skip
    assert client.post(f"/admin/users/{uuid.uuid4()}/quota", headers=admin,
                       json={"agent_queries": 1}).status_code == 404  # fmt: skip
    assert client.get(f"/admin/users/{uuid.uuid4()}/quota", headers=admin).status_code == 404


# --- review follow-ups ------------------------------------------------------------------------------


def test_only_active_verified_accounts_become_admins(
    client: TestClient, world: dict[str, Any], admin: dict[str, str]
) -> None:
    unverified = _new_user(world)
    _sql(world["db"], "UPDATE users SET email_verified_at = NULL WHERE id = %s", unverified)
    r = client.patch(f"/admin/users/{unverified}/role", headers=admin, json={"role": "admin"})
    assert (
        r.status_code == 400 and _msg(r) == "Only an active, verified account can be made an admin."
    )
    bulk = client.post("/admin/users/bulk", headers=admin,
                       json={"ids": [str(unverified)], "action": "set_role", "role": "admin"})  # fmt: skip
    assert bulk.status_code == 400
    assert _sql(world["db"], "SELECT role FROM users WHERE id = %s", unverified) == [("user",)]


def test_reset_password_is_rate_limited_per_address(
    client: TestClient, world: dict[str, Any], admin: dict[str, str]
) -> None:
    uid = _new_user(world)
    codes = [client.post(f"/admin/users/{uid}/reset-password", headers=admin).status_code
             for _ in range(4)]  # fmt: skip
    assert codes == [200, 200, 200, 429]


def test_delete_never_touches_a_forged_key(
    client: TestClient, world: dict[str, Any], admin: dict[str, str], drive: FakeDrive
) -> None:
    victim_key = f"{world['b']}/{uuid.uuid4()}.webm"
    victim_file = f"f{secrets.token_hex(6)}"
    _sql(world["db"], "INSERT INTO storage_objects (key, file_id, size_bytes, content_type) "
         "VALUES (%s, %s, 3, 'audio/webm')", victim_key, victim_file)  # fmt: skip
    uid = _new_user(world)
    _sql(world["db"], "INSERT INTO meetings (user_id, status, audio_path) VALUES (%s, 'done', %s)",
         uid, victim_key)  # fmt: skip
    _sql(world["db"], "UPDATE profiles SET avatar_key = %s WHERE id = %s",
         f"avatars/{world['b']}.png", uid)  # fmt: skip
    assert client.delete(f"/admin/users/{uid}", headers=admin).status_code == 200
    assert victim_file not in drive.deleted
    assert _sql(world["db"], "SELECT count(*) FROM storage_objects WHERE key = %s",
                victim_key) == [(1,)]  # fmt: skip


def test_disable_does_not_deadlock_with_a_concurrent_refresh(
    client: TestClient, world: dict[str, Any], admin: dict[str, str]
) -> None:
    """A refresh holds its token row and then inserts the new token (FK key-share on users)
    while the admin disable waits on that token row: with FOR UPDATE on users this deadlocked."""
    import threading

    import psycopg

    uid = _new_user(world)
    _sql(world["db"], "INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) "
         "VALUES (%s, gen_random_uuid(), %s, now() + interval '1 day')", uid,
         secrets.token_hex(16))  # fmt: skip
    result: dict[str, Any] = {}
    with psycopg.connect(world["db"]) as refresh:
        refresh.execute("SELECT id FROM refresh_tokens WHERE user_id = %s FOR UPDATE", (uid,))

        def disable() -> None:
            result["r"] = client.patch(f"/admin/users/{uid}/status", headers=admin,
                                       json={"disabled": True})  # fmt: skip

        worker = threading.Thread(target=disable)
        worker.start()
        worker.join(1.5)  # the admin request is now waiting on the token row
        refresh.execute(
            "INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) "
            "VALUES (%s, gen_random_uuid(), %s, now() + interval '1 day')",
            (uid, secrets.token_hex(16)),
        )
        refresh.commit()
    worker.join(30)
    assert result["r"].status_code == 200, result["r"].text
    # The token the racing refresh committed is not revoked by this statement, but it is
    # useless: /auth/refresh refuses a disabled user and then revokes everything (§0.3).
    assert _sql(world["db"], "SELECT disabled_at IS NOT NULL FROM users WHERE id = %s", uid) == [
        (True,)
    ]
