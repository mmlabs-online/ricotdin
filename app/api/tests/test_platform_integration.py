"""ARC-06: platform services against a scratch database through the real runtime logins.

Rows are written by the owner with ciphertext in the v1 format (test key) and read back as
ricotdin_service and ricotdin_worker — the roles the API and the pipeline use.
"""

import json
import secrets
import uuid
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
from app.services.config import AppConfigReader
from app.services.crypto import encrypt_with_key
from app.services.keys.source import KeySource
from app.services.platform import Platform
from app.services.storage.config import StorageConfigSource
from app.services.storage.r2 import StorageNotConfigured
from tests.conftest import alembic_upgrade, requires_db

pytestmark = requires_db

KEY = bytes(range(32))
OTHER = bytes(32)


@pytest.fixture(scope="module")
def env() -> Iterator[dict[str, Any]]:
    suffix = secrets.token_hex(3)
    owner = admin_url()
    with scratch_database("platform") as url:
        alembic_upgrade(url)
        svc = ensure_login(
            owner, "ricotdin_service", f"ricotdin_test_svc_{suffix}", connection_limit=5
        )
        wrk = ensure_login(
            owner, "ricotdin_worker", f"ricotdin_test_wrk_{suffix}", connection_limit=5
        )
        try:
            yield {"db": url, "service": svc.url(url), "worker": wrk.url(url)}
        finally:
            drop_login(owner, svc.name)
            drop_login(owner, wrk.name)


def _sql(env: dict[str, Any], query: str, *args: Any) -> None:
    with psycopg.connect(env["db"], autocommit=True) as conn:
        conn.execute(query, args)


def _add_key(env: dict[str, Any], config_key: str, plain: str, *, key: bytes = KEY,
             status: str = "active", offset_s: int = 0) -> str:  # fmt: skip
    s = encrypt_with_key(plain, key)
    row_id = str(uuid.uuid4())
    _sql(
        env,
        "INSERT INTO admin_config (id, config_key, label, value_ciphertext, value_iv, "
        "value_auth_tag, last4, status, created_at) VALUES (%s, %s, 'l', %s, %s, %s, %s, %s, "
        "now() + make_interval(secs => %s))",
        row_id, config_key, s.ciphertext, s.iv, s.auth_tag, plain[-4:], status, offset_s,
    )  # fmt: skip
    return row_id


def _settings(env: dict[str, Any]) -> Settings:
    s = Settings.model_validate({})
    s.database_url_app = None
    s.database_url_service = SecretStr(env["service"])
    s.database_url_worker = SecretStr(env["worker"])
    s.db_pool_service = (2, 0)
    s.db_pool_worker = (2, 0)
    return s


def _with_db(env: dict[str, Any], body: Any) -> Any:
    async def go() -> Any:
        db = await Database.start(_settings(env))
        try:
            return await body(db)
        finally:
            await db.close()

    return anyio.run(go)


@pytest.mark.parametrize("group", ["ricotdin_service", "ricotdin_worker"])
def test_active_keys_decrypt_in_order_skip_bad_rows_and_cache(
    env: dict[str, Any], group: str
) -> None:
    provider = f"gemini_{group}"  # own config_key per parametrised run
    ck = f"{provider}_api_key"
    first = _add_key(env, ck, "key-one-aaaa", offset_s=-7200)
    _add_key(env, ck, "key-two-bbbb", offset_s=-3600)
    _add_key(env, ck, "wrong-key-cccc", key=OTHER)
    _add_key(env, ck, "disabled-dddd", status="disabled")
    now = [0.0]
    source = KeySource(KEY, {}, clock=lambda: now[0])

    async def body(db: Database) -> tuple[list[str], list[str | None], list[str], list[str]]:
        async with db.role_transaction(group) as conn:
            keys = await source.active_keys(conn, provider)
        _add_key(env, ck, "added-later-eeee")
        async with db.role_transaction(group) as conn:
            cached = await source.active_keys(conn, provider)
        source.invalidate(provider)
        async with db.role_transaction(group) as conn:
            fresh = await source.active_keys(conn, provider)
        return (
            [k.key for k in keys],
            [k.id for k in keys],
            [k.key for k in cached],
            [k.key for k in fresh],
        )

    keys, ids, cached, fresh = _with_db(env, body)
    assert keys == ["key-one-aaaa", "key-two-bbbb"]
    assert ids[0] == first
    assert cached == keys  # 30 s cache
    assert fresh == ["key-one-aaaa", "key-two-bbbb", "added-later-eeee"]


def test_env_fallback_when_the_database_has_no_usable_key(env: dict[str, Any]) -> None:
    _add_key(env, "speechmatics_api_key", "undecryptable", key=OTHER)
    source = KeySource(KEY, {"SPEECHMATICS_API_KEY": "from-env"})

    async def body(db: Database) -> list[tuple[str | None, str]]:
        async with db.role_transaction("ricotdin_worker") as conn:
            return [(k.id, k.key) for k in await source.active_keys(conn, "speechmatics")]

    assert _with_db(env, body) == [(None, "from-env")]


def test_without_master_key_stored_keys_are_unusable_and_env_is_used(env: dict[str, Any]) -> None:
    _add_key(env, "openai_api_key", "stored-openai")
    source = KeySource(None, {"OPENAI_API_KEY": "env-openai"})

    async def body(db: Database) -> list[str]:
        async with db.role_transaction("ricotdin_service") as conn:
            return [k.key for k in await source.active_keys(conn, "openai")]

    assert _with_db(env, body) == ["env-openai"]


def _add_storage(env: dict[str, Any], bucket: str, *, key: bytes = KEY, status: str = "active",
                 offset_s: int = 0) -> None:  # fmt: skip
    s = encrypt_with_key(f"secret-{bucket}", key)
    _sql(
        env,
        "INSERT INTO storage_config (provider, label, account_id, access_key_id, bucket, "
        "secret_ciphertext, secret_iv, secret_auth_tag, secret_last4, status, created_at) "
        "VALUES ('r2', 'l', '0123456789abcdef0123456789abcdef', 'AKID', %s, %s, %s, %s, 'last', %s, "
        "now() + make_interval(secs => %s))",
        bucket, s.ciphertext, s.iv, s.auth_tag, status, offset_s,
    )  # fmt: skip


def test_storage_config_newest_active_row_wins_and_none_without_rows(env: dict[str, Any]) -> None:
    source = StorageConfigSource(KEY)

    async def empty(db: Database) -> Any:
        # ricotdin_service: the worker has no access to storage_config (migration 0005).
        async with db.role_transaction("ricotdin_service") as conn:
            return await source.r2(conn)

    assert _with_db(env, empty) is None
    source.invalidate()
    _add_storage(env, "old-bucket", offset_s=-86400)
    _add_storage(env, "new-bucket")
    _add_storage(env, "disabled-bucket", status="disabled", offset_s=86400)

    async def body(db: Database) -> Any:
        async with db.role_transaction("ricotdin_service") as conn:
            return await source.r2(conn)

    cfg = _with_db(env, body)
    assert (cfg.bucket, cfg.secret_access_key, cfg.account_id) == (
        "new-bucket",
        "secret-new-bucket",
        "0123456789abcdef0123456789abcdef",
    )


def test_platform_r2_raises_a_typed_error_when_the_secret_does_not_decrypt(
    env: dict[str, Any],
) -> None:
    _add_storage(env, "foreign-bucket", key=OTHER, offset_s=172800)
    platform = Platform.from_settings(
        Settings.model_validate({"KEY_ENCRYPTION_SECRET": KEY.hex()}), env={}
    )

    async def body(db: Database) -> None:
        async with db.role_transaction("ricotdin_service") as conn:
            await platform.r2(conn)

    with pytest.raises(StorageNotConfigured):
        _with_db(env, body)


def test_app_config_flags_read_through_the_cache_and_fall_back(env: dict[str, Any]) -> None:
    _sql(env, "INSERT INTO app_config (key, value) VALUES ('test.flag_on', 'true'), "
         "('test.flag_bad', %s) ON CONFLICT (key) DO NOTHING", json.dumps("maybe"))  # fmt: skip
    reader = AppConfigReader()

    async def body(db: Database) -> tuple[bool, bool, bool, Any]:
        async with db.role_transaction("ricotdin_worker") as conn:
            on = await reader.flag(conn, "test.flag_on", False)
            bad = await reader.flag(conn, "test.flag_bad", False)
            missing = await reader.flag(conn, "test.missing", True)
            seeded = await reader.value(conn, "pipeline.chunk_minutes")
        return on, bad, missing, seeded

    assert _with_db(env, body) == (True, False, True, 25)


def test_bad_master_key_refuses_to_start() -> None:
    with pytest.raises(ValueError, match="KEY_ENCRYPTION_SECRET"):
        Platform.from_settings(Settings.model_validate({"KEY_ENCRYPTION_SECRET": "short"}), env={})
