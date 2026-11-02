"""ARC-17: migration 0003 (drive_config, storage_objects) grants and the SQL side of DriveStorage,
through the real runtime logins on a scratch database."""

import secrets
from collections.abc import Iterator
from typing import Any

import anyio
import psycopg
import pytest
from pydantic import SecretStr

from app.core.settings import Settings
from app.db.provision import drop_login, ensure_login
from app.db.scratch import admin_url, scratch_database
from app.db.session import Database
from app.services.crypto import encrypt_with_key
from app.services.storage.base import StoredObject
from app.services.storage.config import DriveConfigSource
from app.services.storage.gdrive import SqlObjectMap
from tests.conftest import alembic_upgrade, requires_db

pytestmark = requires_db

KEY = bytes(range(32))
ROOT = "root-folder-0001"


@pytest.fixture(scope="module")
def env() -> Iterator[dict[str, Any]]:
    suffix = secrets.token_hex(3)
    owner = admin_url()
    with scratch_database("drive") as url:
        alembic_upgrade(url)
        svc = ensure_login(
            owner, "ricotdin_service", f"ricotdin_test_dsvc_{suffix}", connection_limit=5
        )
        wrk = ensure_login(
            owner, "ricotdin_worker", f"ricotdin_test_dwrk_{suffix}", connection_limit=5
        )
        try:
            yield {"db": url, "service": svc.url(url), "worker": wrk.url(url)}
        finally:
            drop_login(owner, svc.name)
            drop_login(owner, wrk.name)


def _privs(url: str, role: str, table: str) -> set[str]:
    with psycopg.connect(url) as conn:
        return {
            p
            for p in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER")
            if conn.execute(
                "SELECT has_table_privilege(%s, %s, %s)", (role, f"public.{table}", p)
            ).fetchone()
            == (True,)
        }


def test_app_role_and_public_have_no_access(env: dict[str, Any]) -> None:
    for table in ("drive_config", "storage_objects"):
        assert _privs(env["db"], "ricotdin_app", table) == set()
        assert _privs(env["db"], "public", table) == set()


def test_service_and_worker_privileges(env: dict[str, Any]) -> None:
    crud = {"SELECT", "INSERT", "UPDATE", "DELETE"}
    assert _privs(env["db"], "ricotdin_service", "drive_config") == crud
    assert _privs(env["db"], "ricotdin_service", "storage_objects") == crud
    assert _privs(env["db"], "ricotdin_worker", "drive_config") == {"SELECT"}
    assert _privs(env["db"], "ricotdin_worker", "storage_objects") == crud


def test_rls_is_enabled_and_drive_config_holds_one_row(env: dict[str, Any]) -> None:
    with psycopg.connect(env["db"]) as conn:
        rows = conn.execute(
            "SELECT relname, relrowsecurity FROM pg_class "
            "WHERE relname IN ('drive_config', 'storage_objects') ORDER BY relname"
        ).fetchall()
        assert rows == [("drive_config", True), ("storage_objects", True)]
        with pytest.raises(psycopg.errors.CheckViolation):
            conn.execute(
                "INSERT INTO drive_config (id, client_id, client_secret_ciphertext, client_secret_iv, "
                "client_secret_auth_tag, refresh_token_ciphertext, refresh_token_iv, "
                "refresh_token_auth_tag, root_folder_id, account_email) "
                "VALUES (false, 'c', 'x', 'x', 'x', 'x', 'x', 'x', %s, 'a@b.c')",
                (ROOT,),
            )


def _settings(env: dict[str, Any]) -> Settings:
    s = Settings.model_validate({})
    s.database_url_app = None
    s.database_url_service = SecretStr(env["service"])
    s.database_url_worker = SecretStr(env["worker"])
    s.db_pool_service = (2, 0)
    s.db_pool_worker = (2, 0)
    return s


def test_config_decrypts_and_object_map_round_trips(env: dict[str, Any]) -> None:
    sec = encrypt_with_key("client-secret", KEY)
    ref = encrypt_with_key("1//refresh", KEY)
    with psycopg.connect(env["db"], autocommit=True) as conn:
        conn.execute(
            "INSERT INTO drive_config (client_id, client_secret_ciphertext, client_secret_iv, "
            "client_secret_auth_tag, refresh_token_ciphertext, refresh_token_iv, "
            "refresh_token_auth_tag, root_folder_id, account_email) "
            "VALUES ('cid', %s, %s, %s, %s, %s, %s, %s, 'owner@example.com')",
            (sec.ciphertext, sec.iv, sec.auth_tag, ref.ciphertext, ref.iv, ref.auth_tag, ROOT),
        )
    obj = StoredObject("u/m.webm", "file-0000000001", 123, "audio/webm", "0" * 32)

    async def go() -> tuple[Any, ...]:
        db = await Database.start(_settings(env))
        try:
            async with db.role_transaction("ricotdin_worker") as conn:
                cfg = await DriveConfigSource(KEY).get(conn)
                objects = SqlObjectMap(conn)
                assert await objects.insert(obj)
                assert not await objects.insert(obj)
                got = await objects.get("u/m.webm", for_update=True)
            async with db.role_transaction("ricotdin_service") as conn:
                objects = SqlObjectMap(conn)
                await objects.delete("u/m.webm")
                gone = await objects.get("u/m.webm")
            return cfg, got, gone
        finally:
            await db.close()

    cfg, got, gone = anyio.run(go)
    assert cfg is not None
    assert (cfg.client_secret, cfg.refresh_token, cfg.root_folder_id) == (
        "client-secret",
        "1//refresh",
        ROOT,
    )
    assert got == obj and gone is None


def test_worker_cannot_write_drive_config(env: dict[str, Any]) -> None:
    async def go() -> None:
        db = await Database.start(_settings(env))
        try:
            async with db.role_transaction("ricotdin_worker") as conn:
                from sqlalchemy import text

                await conn.execute(text("UPDATE drive_config SET account_email = 'x@y.z'"))
        finally:
            await db.close()

    with pytest.raises(Exception, match="permission denied"):
        anyio.run(go)
