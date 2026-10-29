"""ARC-03 end to end: a v1 replay seeded like Supabase (GoTrue auth.users columns,
storage.objects) → a v2 database at head. Checks counts/digests, idempotent re-run, secret
decrypt, the storage copy rules, and a real v2 login with the old password (bcrypt → argon2).
"""

import json
import secrets
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import bcrypt
import psycopg
import pytest
from fastapi.testclient import TestClient

from app.auth.jwt import generate_private_pem
from app.core.settings import Settings
from app.db.provision import drop_login, ensure_login
from app.db.replay import replay_v1
from app.db.scratch import admin_url, scratch_database
from app.main import create_app
from app.migration.report import StorageResult
from app.services.crypto import encrypt_with_key
from scripts.migrate_from_supabase import CopyError, copy_storage, run
from tests.conftest import alembic_upgrade, requires_db

pytestmark = requires_db

MASTER = bytes(range(32))
WEB = "https://app.ricotdin.test"
PASSWORD = "old v1 password"
ADMIN = str(uuid.uuid4())
USER = str(uuid.uuid4())
FOLDER = str(uuid.uuid4())
M_LEGACY = str(uuid.uuid4())  # audio in Supabase Storage
M_MISSING = str(uuid.uuid4())  # Supabase row, object gone
M_R2 = str(uuid.uuid4())  # already on R2
SEG = str(uuid.uuid4())

GOTRUE_COLUMNS = """
ALTER TABLE auth.users
  ADD COLUMN encrypted_password text,
  ADD COLUMN email_confirmed_at timestamptz,
  ADD COLUMN banned_until timestamptz,
  ADD COLUMN last_sign_in_at timestamptz,
  ADD COLUMN created_at timestamptz,
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN raw_app_meta_data jsonb,
  ADD COLUMN is_anonymous boolean NOT NULL DEFAULT false,
  ADD COLUMN deleted_at timestamptz;
CREATE SCHEMA storage;
CREATE TABLE storage.objects (bucket_id text, name text, metadata jsonb);
"""


def _enc(text: str) -> tuple[str, str, str]:
    e = encrypt_with_key(text, MASTER)
    return e.ciphertext, e.iv, e.auth_tag


def _seed(conn: psycopg.Connection[Any]) -> None:
    conn.execute(GOTRUE_COLUMNS)
    pw = bcrypt.hashpw(PASSWORD.encode(), bcrypt.gensalt(rounds=4)).decode().replace("$2b$", "$2a$")
    for uid, email, meta, banned in (
        (ADMIN, "Admin@Example.test", {"provider": "email", "role": "admin"}, None),
        (USER, "user@example.test", {"provider": "email"}, "2999-01-01"),
    ):
        conn.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, "
            "banned_until, last_sign_in_at, created_at, updated_at, raw_app_meta_data) "
            "VALUES (%s, %s, %s, '2026-01-02 03:04:05.123456+00', %s, '2026-10-01+00', "
            "'2026-01-01+00', '2026-01-03+00', %s)",
            (uid, email, pw, banned, json.dumps(meta)),
        )
    # profiles.role deliberately wrong for USER: the migration takes users.role.
    conn.execute(
        "INSERT INTO profiles (id, username, role) VALUES (%s, 'admin1', 'admin'), "
        "(%s, 'user1', 'admin')",
        (ADMIN, USER),
    )
    conn.execute("INSERT INTO folders (id, user_id, name) VALUES (%s, %s, 'F')", (FOLDER, ADMIN))
    for mid, provider in ((M_LEGACY, "supabase"), (M_MISSING, "supabase"), (M_R2, "r2")):
        conn.execute(
            "INSERT INTO meetings (id, user_id, folder_id, title, audio_path, storage_provider, "
            "updated_at) VALUES (%s, %s, %s, 'Họp 🎙', %s, %s, '2026-02-02+00')",
            (mid, ADMIN, FOLDER, f"{ADMIN}/{mid}.webm", provider),
        )
    conn.execute(
        "INSERT INTO transcript_segments (id, meeting_id, segment_index, start_ms, end_ms, text) "
        "VALUES (%s, %s, 0, 0, 1000, 'xin chào')",
        (SEG, M_LEGACY),
    )
    vec = "[" + ",".join(f"{(i % 7) / 7:.6f}" for i in range(768)) + "]"
    conn.execute(
        "INSERT INTO transcript_chunks (meeting_id, chunk_index, content, embedding) "
        "VALUES (%s, 0, 'xin chào', %s::vector)",
        (M_LEGACY, vec),
    )
    conn.execute(
        "INSERT INTO todos (meeting_id, content, source_segment_id) VALUES (%s, 'việc', %s)",
        (M_LEGACY, SEG),
    )
    sess = conn.execute(
        "INSERT INTO chat_sessions (user_id, meeting_id) VALUES (%s, %s) RETURNING id",
        (ADMIN, M_LEGACY),
    ).fetchone()
    assert sess is not None
    conn.execute(
        "INSERT INTO chat_messages (session_id, role, content) VALUES (%s, 'user', 'hỏi')",
        (sess[0],),
    )
    ct, iv, tag = _enc("gemini-test-key-not-real")
    conn.execute(
        "INSERT INTO admin_config (config_key, label, value_ciphertext, value_iv, value_auth_tag, "
        "last4, created_by) VALUES ('gemini_api_key', 'k', %s, %s, %s, 'real', %s)",
        (ct, iv, tag, ADMIN),
    )
    ct, iv, tag = _enc("r2-secret-not-real")
    conn.execute(
        "INSERT INTO storage_config (label, account_id, access_key_id, bucket, "
        "secret_ciphertext, secret_iv, secret_auth_tag, secret_last4) VALUES "
        "('r2', '0123456789abcdef0123456789abcdef', 'AKID', 'bucket', %s, %s, %s, 'real')",
        (ct, iv, tag),
    )
    conn.execute(
        "INSERT INTO audit_logs (actor_id, actor_email, action, target_type, target_id) "
        "VALUES (%s, 'x', 'meeting.requeue', 'meeting', %s)",
        (ADMIN, M_LEGACY),
    )
    conn.execute(
        'INSERT INTO storage.objects VALUES (\'recordings\', %s, \'{"size": 5, "mimetype": '
        "\"audio/webm;codecs=opus\"}'), ('recordings', 'orphan.webm', '{\"size\": 1}')",
        (f"{ADMIN}/{M_LEGACY}.webm",),
    )


class FakeSupabase:
    def __init__(self, payload: bytes = b"audio") -> None:
        self.downloads: list[str] = []
        self.payload = payload

    def download(self, key: str, target: Path) -> None:
        self.downloads.append(key)
        target.write_bytes(self.payload)


class FakeR2:
    def __init__(self, objects: dict[str, bytes]) -> None:
        self.objects = objects
        self.uploads: list[tuple[str, str]] = []
        self.fail = False

    def size(self, key: str) -> int | None:
        data = self.objects.get(key)
        return None if data is None else len(data)

    def upload(self, path: Path, key: str, content_type: str) -> None:
        if self.fail:
            raise CopyError("r2 upload 500")
        self.uploads.append((key, content_type))
        self.objects[key] = path.read_bytes()


@pytest.fixture(scope="module")
def dbs() -> Iterator[tuple[str, str]]:
    with scratch_database("mig_src") as src, scratch_database("mig_tgt") as tgt:
        replay_v1(src)
        with psycopg.connect(src, autocommit=True) as conn:
            _seed(conn)
        alembic_upgrade(tgt)
        yield src, tgt


def _q(url: str, query: str, *args: Any) -> list[tuple[Any, ...]]:
    with psycopg.connect(url, autocommit=True) as conn:
        return conn.execute(query, args).fetchall()


def test_blocked_source_writes_nothing() -> None:
    with scratch_database("mig_blk_s") as src, scratch_database("mig_blk_t") as tgt:
        replay_v1(src)
        with psycopg.connect(src, autocommit=True) as conn:
            conn.execute(GOTRUE_COLUMNS)
            conn.execute(
                "INSERT INTO auth.users (id, email, is_anonymous) VALUES (%s, NULL, true)",
                (str(uuid.uuid4()),),
            )
        alembic_upgrade(tgt)
        report = run(src, tgt, MASTER, source_store=None, skip_storage=True)
        assert not report.passed
        assert any("anonymous" in b for b in report.blocked)
        assert _q(tgt, "SELECT count(*) FROM users") == [(0,)]


def test_dry_run_writes_nothing(dbs: tuple[str, str]) -> None:
    src, _ = dbs
    with scratch_database("mig_dry") as tgt:
        alembic_upgrade(tgt)
        report = run(src, tgt, MASTER, source_store=None, dry_run=True)
        assert report.dry_run and not report.blocked and not report.passed
        assert _q(tgt, "SELECT count(*) FROM users") == [(0,)]
        assert {t.table: t.source_rows for t in report.tables}["meetings"] == 3


def test_migration_matches_source_and_is_idempotent(dbs: tuple[str, str]) -> None:
    src, tgt = dbs
    store = FakeSupabase()
    r2 = FakeR2({f"{ADMIN}/{M_R2}.webm": b"x"})
    report = run(
        src, tgt, MASTER, source_store=store, target_store_for=lambda _cfg: r2, r2_bucket="bucket"
    )
    text = report.render()
    assert report.passed, text
    by = {t.table: t for t in report.tables}
    assert by["users"].target_rows == 2 and by["meetings"].target_rows == 3
    assert by["transcript_chunks"].ok and report.embeddings_target == 1
    assert len(report.secrets_ok) == 2 and not report.secrets_failed
    assert report.storage.copied == [f"{ADMIN}/{M_LEGACY}.webm"]
    assert report.storage.missing_at_source == [f"{ADMIN}/{M_MISSING}.webm"]
    assert report.storage.unreferenced_objects == 1
    assert r2.uploads == [(f"{ADMIN}/{M_LEGACY}.webm", "audio/webm;codecs=opus")]
    for secret in ("gemini-test-key-not-real", "r2-secret-not-real", "Admin@Example", PASSWORD):
        assert secret not in text

    # Transform rules landed: role from app_metadata, ban → disabled, profiles follow users,
    # copied updated_at kept (triggers off), copied audio moved to r2.
    users = dict(_q(tgt, "SELECT id::text, role FROM users"))
    assert users == {ADMIN: "admin", USER: "user"}
    assert _q(tgt, "SELECT disabled_at IS NOT NULL FROM users WHERE id = %s", USER) == [(True,)]
    assert _q(tgt, "SELECT role FROM profiles WHERE id = %s", USER) == [("user",)]
    providers = dict(_q(tgt, "SELECT id::text, storage_provider FROM meetings"))
    assert providers == {M_LEGACY: "r2", M_MISSING: "supabase", M_R2: "r2"}
    assert _q(tgt, "SELECT updated_at::text FROM meetings WHERE id = %s", M_LEGACY) == [
        ("2026-02-02 00:00:00+00",)
    ]
    assert _q(
        tgt, "SELECT count(*) FROM pg_trigger WHERE NOT tgenabled = 'O' AND NOT tgisinternal"
    ) == [(0,)]

    # Second run: same counts, nothing duplicated, copied audio stays r2, nothing re-uploaded.
    again = run(
        src, tgt, MASTER, source_store=store, target_store_for=lambda _cfg: r2, r2_bucket="bucket"
    )
    assert again.passed, again.render()
    assert [(t.table, t.target_rows) for t in again.tables] == [
        (t.table, t.target_rows) for t in report.tables
    ]
    assert again.storage.copied == [] and again.storage.already_on_r2 == []
    assert store.downloads == [f"{ADMIN}/{M_LEGACY}.webm"]
    assert _q(tgt, "SELECT storage_provider FROM meetings WHERE id = %s", M_LEGACY) == [("r2",)]


def test_storage_failure_fails_the_report_and_keeps_supabase(dbs: tuple[str, str]) -> None:
    src, _ = dbs
    with scratch_database("mig_tgt2") as tgt:
        alembic_upgrade(tgt)
        r2 = FakeR2({})
        r2.fail = True
        report = run(
            src,
            tgt,
            MASTER,
            source_store=FakeSupabase(),
            target_store_for=lambda _c: r2,
            r2_bucket="bucket",
        )
        assert not report.passed
        assert report.storage.failed == [f"{ADMIN}/{M_LEGACY}.webm: r2 upload 500"]
        assert _q(tgt, "SELECT storage_provider FROM meetings WHERE id = %s", M_LEGACY) == [
            ("supabase",)
        ]


def test_wrong_master_key_fails_the_secret_check(dbs: tuple[str, str]) -> None:
    src, _ = dbs
    with scratch_database("mig_tgt3") as tgt:
        alembic_upgrade(tgt)
        report = run(src, tgt, bytes(32), source_store=None, skip_storage=True)
        assert not report.passed and len(report.secrets_failed) == 2


def test_migrated_user_logs_in_with_the_old_password_and_is_rehashed(
    dbs: tuple[str, str],
) -> None:
    src, tgt = dbs
    run(src, tgt, MASTER, source_store=None, skip_storage=True)
    suffix = secrets.token_hex(3)
    owner = admin_url()
    app_login = ensure_login(
        owner, "ricotdin_app", f"ricotdin_test_api_{suffix}", connection_limit=3
    )
    svc_login = ensure_login(
        owner, "ricotdin_service", f"ricotdin_test_svc_{suffix}", connection_limit=3
    )
    try:
        settings = Settings.model_validate(
            {
                "DATABASE_URL_APP": app_login.url(tgt),
                "DATABASE_URL_SERVICE": svc_login.url(tgt),
                "JWT_PRIVATE_KEY": generate_private_pem(),
                "WEB_ORIGIN": WEB,
            }
        )
        settings.db_pool_app = (2, 0)
        settings.db_pool_service = (2, 0)
        with TestClient(create_app(settings), base_url="https://api.ricotdin.test") as client:
            r = client.post(
                "/auth/login",
                headers={"Origin": WEB},
                json={"identifier": "admin@example.test", "password": PASSWORD},
            )
            assert r.status_code == 200, r.text
            me = client.get(
                "/auth/me", headers={"Authorization": f"Bearer {r.json()['access_token']}"}
            )
            assert me.json()["role"] == "admin"
    finally:
        drop_login(owner, app_login.name)
        drop_login(owner, svc_login.name)
    stored = _q(tgt, "SELECT password_hash FROM users WHERE id = %s", ADMIN)[0][0]
    assert stored.startswith("$argon2id$")


def test_storage_recovery_ownership_size_and_missing_config(dbs: tuple[str, str]) -> None:
    src, _ = dbs
    key = f"{ADMIN}/{M_LEGACY}.webm"
    objects = {key: (5, "audio/webm"), "evil/key.webm": (1, None)}
    with scratch_database("mig_sto") as tgt:
        alembic_upgrade(tgt)
        run(src, tgt, MASTER, source_store=None, skip_storage=True)
        with psycopg.connect(tgt, autocommit=True) as conn:
            conn.execute(
                "UPDATE meetings SET audio_path = 'evil/key.webm' WHERE id = %s", (M_MISSING,)
            )
            # An earlier run uploaded the object but stopped before the row update.
            result = StorageResult()
            copy_storage(conn, objects, FakeSupabase(), FakeR2({key: b"audio"}), result)
            assert result.already_on_r2 == [key] and result.copied == []
            assert result.failed == ["evil/key.webm: not <user_id>/<meeting_id>[.ext] of its row"]
            assert _q(tgt, "SELECT storage_provider FROM meetings WHERE id = %s", M_LEGACY) == [
                ("r2",)
            ]

            conn.execute(
                "UPDATE meetings SET storage_provider = 'supabase' WHERE id = %s", (M_LEGACY,)
            )
            result = StorageResult()
            copy_storage(conn, objects, FakeSupabase(b"abcd"), FakeR2({}), result)
            assert f"{key}: downloaded 4 bytes, storage.objects says 5" in result.failed

            result = StorageResult()
            copy_storage(conn, objects, FakeSupabase(), None, result)
            assert any("no active" in f for f in result.failed)
            assert _q(tgt, "SELECT storage_provider FROM meetings WHERE id = %s", M_LEGACY) == [
                ("supabase",)
            ]


def test_preflight_blocks_type_drift_and_an_old_revision(dbs: tuple[str, str]) -> None:
    src, _ = dbs
    with scratch_database("mig_pre") as tgt:
        alembic_upgrade(tgt)
        with psycopg.connect(tgt, autocommit=True) as conn:
            conn.execute("ALTER TABLE todos ALTER COLUMN content TYPE varchar(500)")
            conn.execute("UPDATE alembic.alembic_version SET version_num = '0001_baseline'")
        report = run(src, tgt, MASTER, source_store=None, skip_storage=True)
        text = " | ".join(report.blocked)
        assert "todos.content" in text and "alembic head" in text
        assert _q(tgt, "SELECT count(*) FROM folders") == [(0,)]


def test_unique_collision_is_reported_by_code_without_values(dbs: tuple[str, str]) -> None:
    src, _ = dbs
    with scratch_database("mig_dup") as tgt:
        alembic_upgrade(tgt)
        with psycopg.connect(tgt, autocommit=True) as conn:
            conn.execute(
                "INSERT INTO users (id, email, password_hash) VALUES (%s, 'admin@example.test', 'x')",
                (str(uuid.uuid4()),),
            )
        report = run(src, tgt, MASTER, source_store=None, skip_storage=True)
        assert report.errors == ["users: UniqueViolation 23505"]
        assert not report.passed and "example" not in report.render().lower()


def test_rows_deleted_in_v1_fail_a_rerun(dbs: tuple[str, str]) -> None:
    src, _ = dbs
    with scratch_database("mig_del") as tgt:
        alembic_upgrade(tgt)
        run(src, tgt, MASTER, source_store=None, skip_storage=True)
        with psycopg.connect(tgt, autocommit=True) as conn:
            conn.execute("INSERT INTO folders (user_id, name) VALUES (%s, 'gone in v1')", (ADMIN,))
        report = run(src, tgt, MASTER, source_store=None, skip_storage=True)
        folders = next(t for t in report.tables if t.table == "folders")
        assert (folders.source_rows, folders.target_rows, folders.ok) == (1, 2, False)
