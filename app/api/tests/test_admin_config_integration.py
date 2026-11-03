# ruff: noqa: F811 - pytest fixtures imported from other integration tests are parameters here
"""ARC-10c: ``/admin/{keys,config,generation-config,features,health,storage}`` end to end
(scratch database, the real API, fake Drive). 403 for non-admins; ciphertext / plaintext never
returned; last active key kept; one audit row per mutation; key pools invalidated."""

import uuid
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient

from tests.conftest import requires_db
from tests.test_admin_users_integration import _new_user, _token, admin  # noqa: F401
from tests.test_meetings_storage_integration import (  # noqa: F401 - fixtures
    _as,
    _msg,
    _sql,
    client,
    drive,
    world,
)

pytestmark = requires_db

ROUTES = [
    ("GET", "/admin/keys"), ("POST", "/admin/keys"), ("PATCH", "/admin/keys/{id}"),
    ("DELETE", "/admin/keys/{id}"), ("GET", "/admin/keys/healthcheck"),
    ("POST", "/admin/keys/healthcheck"), ("GET", "/admin/config"),
    ("PATCH", "/admin/config/user_hack_audio_render"), ("GET", "/admin/generation-config"),
    ("PATCH", "/admin/generation-config"), ("GET", "/admin/features"),
    ("POST", "/admin/features"), ("GET", "/admin/features/ARC-10"),
    ("PATCH", "/admin/features/ARC-10"), ("GET", "/admin/health"), ("GET", "/admin/storage"),
]  # fmt: skip
SECRET = "sk-test-SUPERSECRETVALUE-0000abcd"


def _add_key(client: TestClient, admin: dict[str, str], config_key: str = "openai_api_key",
             key: str = SECRET, label: str = "main") -> dict[str, Any]:  # fmt: skip
    r = client.post("/admin/keys", headers=admin,
                    json={"configKey": config_key, "label": label, "key": key})  # fmt: skip
    assert r.status_code == 201, r.text
    assert SECRET not in r.text and "ciphertext" not in r.text and "auth_tag" not in r.text
    return r.json()["key"]  # type: ignore[no-any-return]


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_non_admins_get_403(
    client: TestClient, world: dict[str, Any], admin: dict[str, str], method: str, path: str
) -> None:
    url = path.format(id=uuid.uuid4())
    kw: dict[str, Any] = {"json": {}} if method in ("POST", "PATCH") else {}
    assert client.request(method, url, headers=_as(client, "b"), **kw).status_code == 403
    demoted = _new_user(world)
    assert client.request(method, url, headers=_token(client, demoted, "admin"),
                          **kw).status_code == 403  # fmt: skip


# --- keys -----------------------------------------------------------------------------------------


def test_keys_are_encrypted_masked_and_audited(
    client: TestClient, world: dict[str, Any], admin: dict[str, str]
) -> None:
    app: Any = client.app
    invalidated: list[str | None] = []
    original = app.state.platform.keys.invalidate

    def spy(provider: str | None = None) -> None:
        invalidated.append(provider)
        original(provider)

    app.state.platform.keys.invalidate = spy
    try:
        row = _add_key(client, admin)
        assert row["last4"] == "abcd" and row["status"] == "active"
        stored = _sql(world["db"], "SELECT value_ciphertext, created_by FROM admin_config "
                      "WHERE id = %s", row["id"])[0]  # fmt: skip
        assert SECRET not in stored[0] and stored[1] == world["a"]
        listed = client.get("/admin/keys", headers=admin)
        assert SECRET not in listed.text and "value_ciphertext" not in listed.text
        assert any(k["id"] == row["id"] for k in listed.json()["keys"])
        audit = _sql(world["db"], "SELECT action, metadata FROM audit_logs WHERE target_id = %s",
                     row["id"])  # fmt: skip
        assert audit == [("admin_config.create", {"configKey": "openai_api_key", "label": "main"})]
        assert invalidated == ["openai"]

        # the stored key really decrypts to what was sent
        from app.services.crypto import EncryptedSecret, decrypt_with_key
        from tests.test_meetings_storage_integration import MASTER

        c, iv, tag = _sql(world["db"], "SELECT value_ciphertext, value_iv, value_auth_tag FROM "
                          "admin_config WHERE id = %s", row["id"])[0]  # fmt: skip
        assert decrypt_with_key(EncryptedSecret(c, iv, tag), MASTER) == SECRET
    finally:
        app.state.platform.keys.invalidate = original


def test_last_active_key_cannot_be_disabled_or_deleted(
    client: TestClient, world: dict[str, Any], admin: dict[str, str]
) -> None:
    only = _add_key(client, admin, "speechmatics_api_key", "smkey-12345678")
    r = client.patch(f"/admin/keys/{only['id']}", headers=admin, json={"status": "disabled"})
    assert r.status_code == 422 and "last active key" in _msg(r)
    assert client.delete(f"/admin/keys/{only['id']}", headers=admin).status_code == 422
    second = _add_key(client, admin, "speechmatics_api_key", "smkey-87654321", "backup")
    r = client.patch(f"/admin/keys/{only['id']}", headers=admin,
                     json={"status": "disabled", "disabled_reason": "rotated"})  # fmt: skip
    assert r.status_code == 200 and r.json()["key"]["disabled_reason"] == "rotated"
    assert client.delete(f"/admin/keys/{only['id']}", headers=admin).json() == {"ok": True}
    r = client.patch(f"/admin/keys/{second['id']}", headers=admin, json={"status": "disabled"})
    assert r.status_code == 422  # now the last one again
    actions = [a[0] for a in _sql(world["db"], "SELECT action FROM audit_logs WHERE target_id = "
                                  "%s ORDER BY created_at", only["id"])]  # fmt: skip
    assert actions == ["admin_config.create", "admin_config.disable", "admin_config.delete"]
    assert client.delete(f"/admin/keys/{uuid.uuid4()}", headers=admin).status_code == 404
    assert client.patch("/admin/keys/nope", headers=admin,
                        json={"status": "active"}).status_code == 404  # fmt: skip


def test_key_validation(client: TestClient, world: dict[str, Any], admin: dict[str, str]) -> None:
    base = {"configKey": "gemini_api_key", "label": "x", "key": "AIzaValidKey123"}
    for body in ({**base, "configKey": "aws_api_key"}, {**base, "key": "short"},
                 {**base, "key": "has space inside"}, {**base, "label": ""}):  # fmt: skip
        assert client.post("/admin/keys", headers=admin, json=body).status_code == 422


def test_healthcheck_probes_and_audits(
    client: TestClient, world: dict[str, Any], admin: dict[str, str], monkeypatch: Any
) -> None:
    from app.routers.admin import config as admin_config

    row = _add_key(client, admin, "grok_api_key", "xai-key-ABCDEFGH")
    seen: list[httpx2.Request] = []

    async def fake_run(db: Any, platform: Any, **kw: Any) -> Any:
        def handle(request: httpx2.Request) -> httpx2.Response:
            seen.append(request)
            return httpx2.Response(401 if "ABCDEFGH" in request.headers.get("authorization", "")
                                   else 200)  # fmt: skip

        return await original(db, platform, transport=httpx2.MockTransport(handle), **kw)

    original = admin_config.run_key_health  # type: ignore[attr-defined]
    monkeypatch.setattr(admin_config, "run_key_health", fake_run)
    r = client.post("/admin/keys/healthcheck", headers=admin)
    assert r.status_code == 200, r.text
    assert "xai-key-ABCDEFGH" not in r.text
    assert all("ABCDEFGH" not in str(req.url) for req in seen)  # never in a URL
    entry = next(k for k in r.json()["keys"] if k["id"] == row["id"])
    assert entry["health_status"] == "unhealthy"
    assert client.get("/admin/keys/healthcheck", headers=admin).json()["lastCheckedAt"]
    assert _sql(world["db"], "SELECT count(*) FROM audit_logs WHERE action = "
                "'admin_config.healthcheck'") == [(1,)]  # fmt: skip


# --- app_config + generation config --------------------------------------------------------------


def test_config_update_is_typed_and_audited(
    client: TestClient, world: dict[str, Any], admin: dict[str, str]
) -> None:
    keys = {c["key"] for c in client.get("/admin/config", headers=admin).json()["config"]}
    assert "user_hack_audio_render" in keys
    r = client.patch("/admin/config/user_hack_audio_render", headers=admin, json={"value": True})
    assert r.status_code == 200 and r.json()["config"]["value"] is True
    assert client.patch("/admin/config/user_hack_audio_render", headers=admin,
                        json={"value": "true"}).status_code == 422  # fmt: skip
    assert client.patch("/admin/config/storage.audio_retention_days", headers=admin,
                        json={"value": 0}).status_code == 422  # fmt: skip
    assert client.patch("/admin/config/nope", headers=admin,
                        json={"value": 1}).status_code == 404  # fmt: skip
    assert _sql(world["db"], "SELECT action, metadata FROM audit_logs WHERE target_id = "
                "'user_hack_audio_render'") == [("config.update", {"value": True})]  # fmt: skip


def test_generation_config(
    client: TestClient, world: dict[str, Any], admin: dict[str, str]
) -> None:
    got = client.get("/admin/generation-config", headers=admin).json()
    assert {"provider": "gemini", "model": "gemini-2.5-flash"} in [
        {"provider": m["provider"], "model": m["model"]} for m in got["registeredModels"]
    ]
    body = {"allowedModels": [{"provider": "gemini", "model": "gemini-2.5-flash"},
                              {"provider": "openai", "model": "gpt-4o"}],
            "systemDefault": {"provider": "openai", "model": "gpt-4o"}}  # fmt: skip
    r = client.patch("/admin/generation-config", headers=admin, json=body)
    assert r.status_code == 200, r.text
    assert r.json()["config"]["systemDefault"] == {"provider": "openai", "model": "gpt-4o"}
    # dropping the current default from the allow-list is refused
    r = client.patch("/admin/generation-config", headers=admin,
                     json={"allowedModels": [{"provider": "gemini",
                                              "model": "gemini-2.5-flash"}]})  # fmt: skip
    assert r.status_code == 400
    bad = client.patch("/admin/generation-config", headers=admin,
                       json={"allowedModels": [{"provider": "x", "model": "y"}]})  # fmt: skip
    assert bad.status_code == 400
    assert _sql(world["db"], "SELECT count(*) FROM audit_logs WHERE action = "
                "'generation_config.update'") == [(1,)]  # fmt: skip


# --- features -------------------------------------------------------------------------------------


def test_features_crud(client: TestClient, world: dict[str, Any], admin: dict[str, str]) -> None:
    body = {"key": "tst-1", "module_prefix": "TST", "module_name": "Test", "title": "First",
            "depends_on": ["ARC-1"]}  # fmt: skip
    r = client.post("/admin/features", headers=admin, json=body)
    assert r.status_code == 201, r.text
    fid = r.json()["feature"]["id"]
    assert r.json()["feature"]["key"] == "TST-1" and r.json()["feature"]["depends_on"] == ["ARC-1"]
    assert client.post("/admin/features", headers=admin, json=body).status_code == 409
    assert client.get("/admin/features/tst-1", headers=admin).json()["feature"]["id"] == fid
    assert client.get(f"/admin/features/{fid}", headers=admin).status_code == 200
    r = client.patch("/admin/features/TST-1", headers=admin, json={"status": "done",
                                                                   "title": "Renamed"})  # fmt: skip
    assert r.json()["feature"]["status"] == "done" and r.json()["feature"]["updated_by"]
    listed = client.get("/admin/features?module_prefix=tst&search=renamed", headers=admin).json()
    assert [f["key"] for f in listed["features"]] == ["TST-1"]
    assert client.patch("/admin/features/TST-1", headers=admin,
                        json={"status": "wip"}).status_code == 422  # fmt: skip
    assert client.get("/admin/features/NOPE-1", headers=admin).status_code == 404
    actions = [a[0] for a in _sql(world["db"], "SELECT action FROM audit_logs WHERE target_id = "
                                  "%s ORDER BY created_at", fid)]  # fmt: skip
    assert actions == ["feature.create", "feature.update"]
    meta = _sql(world["db"], "SELECT metadata FROM audit_logs WHERE action = 'feature.update' "
                "AND target_id = %s", fid)[0][0]  # fmt: skip
    assert meta == {"key": "TST-1", "changed_fields": ["status", "title"]}


# --- health + storage -----------------------------------------------------------------------------


def test_health_and_storage(
    client: TestClient, world: dict[str, Any], admin: dict[str, str]
) -> None:
    r = client.get("/admin/health", headers=admin)
    assert r.status_code in (200, 503)
    body = r.json()
    assert body["checks"]["database"] == {"status": "ok"}
    assert {"storage", "worker"} <= set(body["checks"])
    assert body["status"] == ("ok" if r.status_code == 200 else "degraded")
    storage = client.get("/admin/storage", headers=admin)
    assert storage.status_code == 200
    assert set(storage.json()) == {"drive", "objects"} and "refresh" not in storage.text.lower()
