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
    _allowed(
        db,
        "UPDATE jobs SET status = 'queued', step = 'start', attempts = 1, last_error = 'x', "
        "run_after = now(), payload = '{}', locked_at = NULL, locked_by = NULL "
        "WHERE meeting_id = %s",
        MEETING,
    )
    for column, value in [("meeting_id", MEETING), ("max_attempts", 99), ("created_at", None)]:
        _denied(db, f"UPDATE jobs SET {column} = %s", value)  # noqa: S608
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
    # 08e adds a definer function for the retention purge's audit row (forced system actor).
    _denied(
        db,
        "INSERT INTO audit_logs (action, actor_email, target_type, target_id) "
        "VALUES ('x', 'admin@example.test', 'meeting', 'm')",
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


def test_worker_is_granted_only_the_pipeline_functions(db: str) -> None:
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
        movement = conn.execute(
            "SELECT has_function_privilege(%s, 'quota_apply_movement(uuid,bigint,integer,text,"
            "text,boolean,uuid,uuid,jsonb)', 'EXECUTE')",
            (WORKER,),
        ).fetchone()
        wrappers_public = conn.execute(
            "SELECT bool_or(has_function_privilege(r, p.oid, 'EXECUTE')) FROM pg_proc p, "
            "unnest(ARRAY['ricotdin_app', 'ricotdin_service']) r "
            "WHERE p.proname LIKE 'pipeline\\_%%'"
        ).fetchone()
    assert granted == {"claim_next_job", "pipeline_reserve", "pipeline_refund", "pipeline_settle",
                       "quota_reconcile_wallets", "retention_purge_audit"}  # fmt: skip  # 0006
    assert movement == (False,)  # the worker cannot move any user's quota
    assert wrappers_public == (False,)


def test_worker_cannot_call_quota_apply_movement(db: str) -> None:
    _denied(
        db,
        "SELECT * FROM quota_apply_movement(%s, 1000, 0, 'topup', NULL, false, NULL, NULL, '{}')",
        USER,
    )


# --- pipeline quota wrappers -----------------------------------------------------------------


@contextmanager
def _quota_world(url: str, balance: int = 100) -> Iterator[tuple[psycopg.Connection[Any], Any]]:
    """A running job on a fresh meeting of a fresh user (+ a bystander), as the worker; all rolled
    back."""
    user, other, meeting = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    with psycopg.connect(url) as conn:
        for u in (user, other):
            conn.execute(
                "INSERT INTO users (id, email, password_hash) VALUES (%s, %s, 'x')",
                (u, f"{u.hex[:10]}@example.test"),
            )
            conn.execute(
                "INSERT INTO quota_wallets (user_id, audio_seconds_remaining) VALUES (%s, %s)",
                (u, balance),
            )
        conn.execute("INSERT INTO meetings (id, user_id) VALUES (%s, %s)", (meeting, user))
        job = conn.execute(
            "INSERT INTO jobs (meeting_id, status) VALUES (%s, 'running') RETURNING id", (meeting,)
        ).fetchone()
        assert job is not None
        conn.execute(f"SET LOCAL ROLE {WORKER}")
        try:
            yield conn, type("W", (), {"user": user, "other": other, "job": job[0]})
        finally:
            conn.rollback()


def _wallet(conn: psycopg.Connection[Any], user: uuid.UUID) -> int:
    conn.execute("RESET ROLE")
    row = conn.execute(
        "SELECT audio_seconds_remaining FROM quota_wallets WHERE user_id = %s", (user,)
    ).fetchone()
    conn.execute(f"SET LOCAL ROLE {WORKER}")
    assert row is not None
    return int(row[0])


def _ledger_keys(conn: psycopg.Connection[Any], user: uuid.UUID) -> list[tuple[str, int]]:
    conn.execute("RESET ROLE")
    rows = conn.execute(
        "SELECT dedup_key, delta_audio_seconds FROM quota_ledger WHERE user_id = %s "
        "ORDER BY delta_audio_seconds",
        (user,),
    ).fetchall()
    conn.execute(f"SET LOCAL ROLE {WORKER}")
    return [(r[0], int(r[1])) for r in rows]


def test_reserve_charges_only_the_meeting_owner_once(db: str) -> None:
    with _quota_world(db) as (conn, w):
        first = conn.execute("SELECT * FROM pipeline_reserve(%s, 30)", (w.job,)).fetchone()
        again = conn.execute("SELECT * FROM pipeline_reserve(%s, 30)", (w.job,)).fetchone()
        assert first == ("applied", 70) and again is not None and again[0] == "already_applied"
        assert (_wallet(conn, w.user), _wallet(conn, w.other)) == (70, 100)
        assert _ledger_keys(conn, w.user) == [(f"gen:{w.job}:reserve", -30)]


def test_reserve_insufficient_moves_nothing(db: str) -> None:
    with _quota_world(db, balance=10) as (conn, w):
        row = conn.execute("SELECT * FROM pipeline_reserve(%s, 30)", (w.job,)).fetchone()
        assert row == ("insufficient", 10)
        assert _ledger_keys(conn, w.user) == []


@pytest.mark.parametrize("seconds", [0, -5, 86401])
def test_reserve_refuses_out_of_range_amounts(db: str, seconds: int) -> None:
    with _quota_world(db) as (conn, w), pytest.raises(psycopg.errors.InvalidParameterValue):
        conn.execute("SELECT * FROM pipeline_reserve(%s, %s)", (w.job, seconds))


def test_reserve_needs_a_running_job(db: str) -> None:
    with _quota_world(db) as (conn, w):
        conn.execute("UPDATE jobs SET status = 'queued' WHERE id = %s", (w.job,))
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            conn.execute("SELECT * FROM pipeline_reserve(%s, 5)", (w.job,))
    with _quota_world(db) as (conn, _w), pytest.raises(psycopg.errors.InvalidParameterValue):
        conn.execute("SELECT * FROM pipeline_reserve(%s, 5)", (uuid.uuid4(),))


def _status(conn: psycopg.Connection[Any], job: Any, status: str) -> None:
    conn.execute("UPDATE jobs SET status = %s WHERE id = %s", (status, job))


def test_refund_gives_back_exactly_the_reserve_once(db: str) -> None:
    with _quota_world(db) as (conn, w):
        conn.execute("SELECT * FROM pipeline_reserve(%s, 30)", (w.job,))
        _status(conn, w.job, "failed")  # the runner fails the job first, then refunds
        assert conn.execute("SELECT * FROM pipeline_refund(%s)", (w.job,)).fetchone() == (
            "applied", 30,
        )  # fmt: skip
        again = conn.execute("SELECT * FROM pipeline_refund(%s)", (w.job,)).fetchone()
        assert again is not None and again[0] == "already_applied"
        assert _wallet(conn, w.user) == 100
        assert _ledger_keys(conn, w.user) == [
            (f"gen:{w.job}:reserve", -30), (f"gen:{w.job}:refund", 30),
        ]  # fmt: skip
        # no settle after a refund: the job is no longer running
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            conn.execute("SELECT * FROM pipeline_settle(%s, 10)", (w.job,))


def test_refund_without_a_reserve_is_a_no_op(db: str) -> None:
    with _quota_world(db) as (conn, w):
        _status(conn, w.job, "failed")
        assert conn.execute("SELECT * FROM pipeline_refund(%s)", (w.job,)).fetchone() == (
            "nothing_reserved", 0,
        )  # fmt: skip


@pytest.mark.parametrize("status", ["running", "queued", "done"])
def test_refund_only_for_a_failed_job(db: str, status: str) -> None:
    with _quota_world(db) as (conn, w):
        conn.execute("SELECT * FROM pipeline_reserve(%s, 30)", (w.job,))
        _status(conn, w.job, status)
        with pytest.raises(psycopg.errors.InvalidParameterValue), conn.transaction():
            conn.execute("SELECT * FROM pipeline_refund(%s)", (w.job,))
        assert _wallet(conn, w.user) == 70


@pytest.mark.parametrize("status", ["queued", "failed", "done"])
def test_settle_only_for_a_running_job(db: str, status: str) -> None:
    with _quota_world(db) as (conn, w):
        conn.execute("SELECT * FROM pipeline_reserve(%s, 30)", (w.job,))
        _status(conn, w.job, status)
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            conn.execute("SELECT * FROM pipeline_settle(%s, 10)", (w.job,))


def test_settle_charges_the_difference_and_blocks_a_later_refund(db: str) -> None:
    with _quota_world(db) as (conn, w):
        assert conn.execute("SELECT * FROM pipeline_settle(%s, 10)", (w.job,)).fetchone() == (
            "nothing_reserved", 0,
        )  # fmt: skip
        conn.execute("SELECT * FROM pipeline_reserve(%s, 30)", (w.job,))
        assert conn.execute("SELECT * FROM pipeline_settle(%s, 45)", (w.job,)).fetchone() == (
            "applied", -15,
        )  # fmt: skip
        assert _wallet(conn, w.user) == 55
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            conn.execute("SELECT * FROM pipeline_settle(%s, 86401)", (w.job,))
    with _quota_world(db) as (conn, w):
        conn.execute("SELECT * FROM pipeline_reserve(%s, 30)", (w.job,))
        conn.execute("SELECT * FROM pipeline_settle(%s, 45)", (w.job,))
        _status(conn, w.job, "failed")  # e.g. analyse fails after the settle
        assert conn.execute("SELECT * FROM pipeline_refund(%s)", (w.job,)).fetchone() == (
            "settled", 0,
        )  # fmt: skip
        assert _wallet(conn, w.user) == 55


def test_concurrent_refund_and_settle_apply_only_one(db: str) -> None:
    # Follow-up of review round 1: without a per-job lock both saw the other's row absent and both
    # applied. The refund's transaction (job failed + refund) holds the lock; the settle waits, then
    # sees the job is no longer running.
    import threading

    user, meeting = uuid.uuid4(), uuid.uuid4()
    with psycopg.connect(db, autocommit=True) as owner:
        owner.execute(
            "INSERT INTO users (id, email, password_hash) VALUES (%s, %s, 'x')",
            (user, f"{user.hex[:10]}@example.test"),
        )
        owner.execute(
            "INSERT INTO quota_wallets (user_id, audio_seconds_remaining) VALUES (%s, 100)", (user,)
        )
        owner.execute("INSERT INTO meetings (id, user_id) VALUES (%s, %s)", (meeting, user))
        job = owner.execute(
            "INSERT INTO jobs (meeting_id, status) VALUES (%s, 'running') RETURNING id", (meeting,)
        ).fetchone()[0]  # type: ignore[index]
        owner.execute(f"SET ROLE {WORKER}")
        owner.execute("SELECT * FROM pipeline_reserve(%s, 30)", (job,))
    settle: dict[str, Any] = {}
    try:
        with psycopg.connect(db) as a, psycopg.connect(db) as b:
            a.execute(f"SET LOCAL ROLE {WORKER}")
            a.execute("UPDATE jobs SET status = 'failed' WHERE id = %s", (job,))
            assert a.execute("SELECT * FROM pipeline_refund(%s)", (job,)).fetchone() == (
                "applied", 30,
            )  # fmt: skip
            b.execute(f"SET LOCAL ROLE {WORKER}")

            def run_settle() -> None:
                try:
                    settle["row"] = b.execute(
                        "SELECT * FROM pipeline_settle(%s, 10)", (job,)
                    ).fetchone()
                except psycopg.Error as exc:
                    settle["error"] = exc
                b.rollback()

            thread = threading.Thread(target=run_settle)
            thread.start()
            thread.join(1.0)
            assert thread.is_alive()  # waiting for the job's lock
            a.commit()
            thread.join(10.0)
            assert not thread.is_alive()
        assert isinstance(settle.get("error"), psycopg.errors.InvalidParameterValue)
        with psycopg.connect(db, autocommit=True) as owner:
            keys = owner.execute(
                "SELECT dedup_key FROM quota_ledger WHERE user_id = %s ORDER BY dedup_key", (user,)
            ).fetchall()
            wallet = owner.execute(
                "SELECT audio_seconds_remaining FROM quota_wallets WHERE user_id = %s", (user,)
            ).fetchone()
        assert keys == [(f"gen:{job}:refund",), (f"gen:{job}:reserve",)]
        assert wallet == (100,)
    finally:
        with psycopg.connect(db, autocommit=True) as owner:
            owner.execute("DELETE FROM users WHERE id = %s", (user,))


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
        "app_settings", "quota_wallets", "profiles", "usage_log", "activity_log",
        "scheduler_runs",  # 0006
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
