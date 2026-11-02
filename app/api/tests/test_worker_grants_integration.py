"""ARC-08 migration 0005: ricotdin_worker gets an explicit per-table allow-list (ARC-04 security
review) and jobs get one queued/running row per meeting. Checked as the role itself (SET ROLE in
a rolled-back transaction) on a scratch database."""

import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import psycopg
import pytest

from app.db.scratch import scratch_database
from tests.conftest import alembic_downgrade, alembic_upgrade, requires_db

pytestmark = requires_db

USER = uuid.uuid4()
MEETING = uuid.uuid4()
WORKER = "ricotdin_worker"


@pytest.fixture(scope="module")
def db() -> Iterator[str]:
    with scratch_database("wgrants") as url:
        alembic_upgrade(url)
        with psycopg.connect(url, autocommit=True) as conn:
            conn.execute(
                "INSERT INTO users (id, email, password_hash, role) VALUES (%s, 'w@example.test', 'x', 'user')",
                (USER,),
            )
            conn.execute("INSERT INTO profiles (id, username) VALUES (%s, 'wuser')", (USER,))
            conn.execute(
                "INSERT INTO meetings (id, user_id, title) VALUES (%s, %s, 'm')", (MEETING, USER)
            )
            conn.execute("INSERT INTO jobs (meeting_id) VALUES (%s)", (MEETING,))
            conn.execute(
                "INSERT INTO admin_config (config_key, label, value_ciphertext, value_iv, value_auth_tag, last4) "
                "VALUES ('gemini_api_key', 'k', 'c', 'i', 't', 'abcd')"
            )
        yield url


@contextmanager
def as_worker(url: str) -> Iterator[psycopg.Connection[Any]]:
    with psycopg.connect(url) as conn:
        conn.execute(f"SET LOCAL ROLE {WORKER}")
        try:
            yield conn
        finally:
            conn.rollback()


def _denied(url: str, statement: str, *args: Any) -> None:
    with as_worker(url) as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute(statement, args or None)


def _allowed(url: str, statement: str, *args: Any) -> None:
    with as_worker(url) as conn:
        conn.execute(statement, args or None)


@pytest.mark.parametrize(
    "table",
    ["users", "refresh_tokens", "email_tokens", "folders", "folder_shares", "chat_sessions",
     "chat_messages", "features", "storage_config", "quota_ledger", "activity_log", "usage_log",
     "audit_logs"],
)  # fmt: skip
def test_worker_cannot_read_tables_outside_the_allow_list(db: str, table: str) -> None:
    _denied(db, f"SELECT 1 FROM {table}")  # noqa: S608 - fixed table names


@pytest.mark.parametrize(
    "statement",
    [
        "SELECT id, status, audio_path, user_id, duration_seconds FROM meetings",
        "SELECT * FROM jobs",
        "SELECT * FROM transcript_segments",
        "SELECT * FROM transcript_chunks",
        "SELECT * FROM todos",
        "SELECT * FROM calendar_suggestions",
        "SELECT * FROM storage_objects",
        "SELECT * FROM drive_config",
        "SELECT id, value_ciphertext, health_status FROM admin_config",
        "SELECT * FROM app_config",
        "SELECT * FROM app_settings",
        "SELECT * FROM quota_wallets",
        "SELECT id, default_provider, default_model FROM profiles",
    ],
)
def test_worker_reads_what_the_pipeline_needs(db: str, statement: str) -> None:
    _allowed(db, statement)


@pytest.mark.parametrize("column", ["username", "role", "display_name", "avatar_key"])
def test_worker_reads_only_the_model_columns_of_profiles(db: str, column: str) -> None:
    _denied(db, f"SELECT {column} FROM profiles")  # noqa: S608


def test_worker_updates_pipeline_columns_of_meetings_only(db: str) -> None:
    _allowed(
        db,
        "UPDATE meetings SET status = 'processing', error_message = NULL, summary = 's', "
        "notes = 'n', language = 'en', generation_provider = 'gemini', "
        "generation_model = 'gemini-2.5-flash', duration_seconds = 3, audio_path = NULL, "
        "audio_purged_at = now() WHERE id = %s",
        MEETING,
    )
    for column, value in [("user_id", USER), ("title", "x"), ("folder_id", None),
                          ("pinned_at", None), ("storage_provider", "gdrive")]:  # fmt: skip
        _denied(db, f"UPDATE meetings SET {column} = %s WHERE id = %s", value, MEETING)  # noqa: S608
    _denied(db, "DELETE FROM meetings")
    _denied(db, "INSERT INTO meetings (user_id) VALUES (%s)", USER)


def test_worker_updates_jobs_but_never_creates_or_deletes_them(db: str) -> None:
    _allowed(db, "UPDATE jobs SET last_error = 'x' WHERE meeting_id = %s", MEETING)
    _denied(db, "INSERT INTO jobs (meeting_id) VALUES (%s)", MEETING)
    _denied(db, "DELETE FROM jobs")


def test_worker_writes_pipeline_output(db: str) -> None:
    with as_worker(db) as conn:
        conn.execute(
            "INSERT INTO transcript_segments (meeting_id, segment_index, start_ms, end_ms, text) "
            "VALUES (%s, 0, 0, 1000, 'hi')",
            (MEETING,),
        )
        conn.execute("INSERT INTO todos (meeting_id, content) VALUES (%s, 'do it')", (MEETING,))
        conn.execute(
            "INSERT INTO calendar_suggestions (meeting_id, title) VALUES (%s, 't')", (MEETING,)
        )
        conn.execute("DELETE FROM transcript_segments WHERE meeting_id = %s", (MEETING,))
        conn.execute("DELETE FROM transcript_chunks WHERE meeting_id = %s", (MEETING,))


def test_worker_appends_to_logs(db: str) -> None:
    with as_worker(db) as conn:
        conn.execute(
            "INSERT INTO activity_log (user_id, event_type, meeting_id) VALUES (%s, 'processing_done', %s)",
            (USER, MEETING),
        )
        conn.execute(
            "INSERT INTO usage_log (provider, model, operation, unit, quantity) "
            "VALUES ('gemini', 'm', 'analyse', 'tokens', 1)"
        )
        conn.execute(
            "INSERT INTO audit_logs (action, actor_email, target_type, target_id) "
            "VALUES ('meeting.audio_purged', 'system:retention', 'meeting', %s)",
            (str(MEETING),),
        )


def test_worker_updates_only_key_health_columns(db: str) -> None:
    _allowed(
        db,
        "UPDATE admin_config SET health_status = 'healthy', health_checked_at = now(), "
        "health_detail = 'ok', last_used_at = now()",
    )
    _denied(db, "UPDATE admin_config SET value_ciphertext = 'x'")
    _denied(db, "UPDATE admin_config SET status = 'disabled'")
    _denied(db, "DELETE FROM admin_config")
    _denied(db, "UPDATE app_config SET value = 'true'::jsonb")


def test_worker_is_granted_only_the_two_pipeline_functions(db: str) -> None:
    # Explicit grants. can_access_meeting (answers only for app.user_id, unset for the worker)
    # and the SECURITY INVOKER match_transcript_chunks stay PUBLIC-executable as in v1.
    with psycopg.connect(db, autocommit=True) as conn:
        granted = {
            r[0]
            for r in conn.execute(
                "SELECT p.proname FROM pg_proc p, aclexplode(p.proacl) x "
                "JOIN pg_roles g ON g.oid = x.grantee "
                "WHERE p.pronamespace = 'public'::regnamespace AND g.rolname = %s",
                (WORKER,),
            )
        }
    assert granted == {"claim_next_job", "quota_apply_movement"}


def test_worker_policies_cover_only_kept_tables(db: str) -> None:
    with psycopg.connect(db, autocommit=True) as conn:
        tables = {
            r[0]
            for r in conn.execute(
                "SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND %s = ANY (roles)",
                (WORKER,),
            )
        }
    assert tables == {
        "meetings", "jobs", "transcript_segments", "transcript_chunks", "todos",
        "calendar_suggestions", "storage_objects", "drive_config", "admin_config", "app_config",
        "app_settings", "quota_wallets", "profiles", "usage_log", "activity_log", "audit_logs",
    }  # fmt: skip


def test_one_active_job_per_meeting(db: str) -> None:
    with psycopg.connect(db) as conn:
        with pytest.raises(psycopg.errors.UniqueViolation):
            conn.execute("INSERT INTO jobs (meeting_id, status) VALUES (%s, 'running')", (MEETING,))
        conn.rollback()
        # finished jobs do not count
        conn.execute("UPDATE jobs SET status = 'done' WHERE meeting_id = %s", (MEETING,))
        conn.execute("INSERT INTO jobs (meeting_id) VALUES (%s)", (MEETING,))
        conn.rollback()


def test_0005_resolves_duplicates_and_its_downgrade_restores_0004() -> None:
    from app.db.introspect import read_schema
    from app.db.parity import to_catalog

    with scratch_database("w0005") as url:
        alembic_upgrade(url, "0004_meetings_gdrive")
        expected = to_catalog(read_schema(url), v1=False)
        with psycopg.connect(url, autocommit=True) as conn:
            conn.execute(
                "INSERT INTO users (id, email, password_hash, role) VALUES (%s, 'd@example.test', 'x', 'user')",
                (USER,),
            )
            conn.execute("INSERT INTO meetings (id, user_id) VALUES (%s, %s)", (MEETING, USER))
            ids = [uuid.UUID(int=i) for i in (1, 2, 3, 4)]
            for i, (jid, status) in enumerate(
                zip(ids, ["running", "queued", "queued", "done"], strict=True)
            ):
                conn.execute(
                    "INSERT INTO jobs (id, meeting_id, status, created_at) "
                    "VALUES (%s, %s, %s, now() - make_interval(mins => %s))",
                    (jid, MEETING, status, 10 - i),
                )
            # same created_at: the id decides
            conn.execute(
                "UPDATE jobs SET created_at = (SELECT created_at FROM jobs WHERE id = %s) WHERE id = %s",
                (ids[2], ids[1]),
            )
        alembic_upgrade(url)
        with psycopg.connect(url, autocommit=True) as conn:
            rows: dict[uuid.UUID, str] = dict(
                conn.execute("SELECT id, status FROM jobs").fetchall()
            )
            failed = conn.execute(
                "SELECT count(*) FROM jobs WHERE last_error = 'duplicate active job (migration 0005)'"
            ).fetchone()
        assert rows == {ids[0]: "failed", ids[1]: "failed", ids[2]: "queued", ids[3]: "done"}
        assert failed == (2,)
        with psycopg.connect(url, autocommit=True) as conn:  # the catalog includes row data
            conn.execute("DELETE FROM jobs")
            conn.execute("DELETE FROM meetings")
            conn.execute("DELETE FROM users")
        alembic_downgrade(url, "0004_meetings_gdrive")
        assert to_catalog(read_schema(url), v1=False) == expected
