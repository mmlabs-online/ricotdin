"""ARC-08e migration 0006: scheduler_runs grants, the wallet reconcile function (BUG-021: the
wallet is SET to the ledger sum) and the retention purge audit function (forced system actor,
only for a meeting just purged). As the worker role on a scratch database."""

import uuid
from collections.abc import Iterator
from typing import Any

import psycopg
import pytest

from app.db.scratch import scratch_database
from tests.conftest import alembic_downgrade, alembic_upgrade, requires_db

pytestmark = requires_db

WORKER = "ricotdin_worker"


@pytest.fixture(scope="module")
def db() -> Iterator[str]:
    with scratch_database("wsched") as url:
        alembic_upgrade(url)
        yield url


def _user(url: str, audio: int = 100) -> uuid.UUID:
    uid = uuid.uuid4()
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute("INSERT INTO users (id, email, password_hash, role) VALUES (%s, %s, 'x', "
                     "'user')", (uid, f"{uid.hex[:10]}@example.test"))  # fmt: skip
        conn.execute(
            "INSERT INTO profiles (id, username) VALUES (%s, %s)", (uid, f"s{uid.hex[:10]}")
        )
        conn.execute("INSERT INTO quota_wallets (user_id, audio_seconds_remaining) VALUES (%s, 0)",
                     (uid,))  # fmt: skip
        conn.execute("SELECT * FROM quota_apply_movement(%s, %s, 0, 'topup', %s, false, NULL, "
                     "NULL, '{}')", (uid, audio, f"topup:{uid}"))  # fmt: skip
    return uid


def _as_worker(url: str, sql: str, *args: Any) -> list[tuple[Any, ...]]:
    with psycopg.connect(url) as conn:
        conn.execute(f"SET LOCAL ROLE {WORKER}")
        cur = conn.execute(sql, args or None)
        rows = cur.fetchall() if cur.description else []
        conn.commit()
        return rows


def _q(url: str, sql: str, *args: Any) -> list[tuple[Any, ...]]:
    with psycopg.connect(url, autocommit=True) as conn:
        cur = conn.execute(sql, args or None)
        return cur.fetchall() if cur.description else []


def test_scheduler_runs_seeded_and_worker_can_lease_but_not_add(db: str) -> None:
    assert sorted(r[0] for r in _q(db, "SELECT task FROM scheduler_runs")) == [
        "key_health", "retention_purge", "stuck_meetings", "wallet_reconcile",
    ]  # fmt: skip
    _as_worker(db, "UPDATE scheduler_runs SET lease_owner = 'w1' WHERE task = 'key_health'")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        _as_worker(db, "INSERT INTO scheduler_runs (task) VALUES ('evil')")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        _as_worker(db, "DELETE FROM scheduler_runs")
    with psycopg.connect(db) as conn:
        conn.execute("SET LOCAL ROLE ricotdin_app")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("SELECT * FROM scheduler_runs")


def test_reconcile_sets_a_drifted_wallet_to_the_ledger_sum_once(db: str) -> None:
    good, bad = _user(db, 100), _user(db, 50)
    _q(db, "UPDATE quota_wallets SET audio_seconds_remaining = 999 WHERE user_id = %s", bad)
    run = uuid.uuid4()
    checked, drifted = _as_worker(db, "SELECT * FROM quota_reconcile_wallets(%s)", run)[0]
    assert drifted >= 1 and checked >= 2
    wallets = dict(_q(db, "SELECT user_id, audio_seconds_remaining FROM quota_wallets "
                       "WHERE user_id IN (%s, %s)", good, bad))  # fmt: skip
    assert wallets == {good: 100, bad: 50}
    trail = _q(db, "SELECT delta_audio_seconds, reason, metadata->>'wallet_audio_before' FROM "
               "quota_ledger WHERE user_id = %s AND reason = 'adjustment'", bad)  # fmt: skip
    assert trail == [(0, "adjustment", "999")]
    # BUG-021: a second run finds nothing left to fix (v1 shifted the balance every run).
    assert _as_worker(db, "SELECT drifted FROM quota_reconcile_wallets(%s)", uuid.uuid4()) == [(0,)]
    assert _q(db, "SELECT audio_seconds_remaining FROM quota_wallets WHERE user_id = %s", bad) == [
        (50,)
    ]


def test_worker_still_cannot_touch_the_ledger(db: str) -> None:
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        _as_worker(db, "SELECT count(*) FROM quota_ledger")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        _as_worker(db, "SELECT count(*) FROM audit_logs")


def test_purge_audit_only_for_a_meeting_just_purged(db: str) -> None:
    uid = _user(db)
    mid = _q(db, "INSERT INTO meetings (user_id, status, audio_path, storage_provider) VALUES "
             "(%s, 'done', %s, 'gdrive') RETURNING id", uid, f"{uid}/x.webm")[0][0]  # fmt: skip
    with pytest.raises(psycopg.errors.InvalidParameterValue):  # still has audio
        _as_worker(db, "SELECT retention_purge_audit(%s, 'k', 30)", mid)
    _q(db, "UPDATE meetings SET audio_path = NULL, audio_purged_at = now() WHERE id = %s", mid)
    _as_worker(db, "SELECT retention_purge_audit(%s, %s, 30)", mid, f"{uid}/{mid}.webm")
    rows = _q(db, "SELECT actor_id, actor_email, action, target_id, metadata->>'retention_days' "
              "FROM audit_logs WHERE target_id = %s", str(mid))  # fmt: skip
    assert rows == [(None, "system:retention", "meeting.audio_purged", str(mid), "30")]
    _q(db, "UPDATE meetings SET audio_purged_at = now() - interval '2 hours' WHERE id = %s", mid)
    with pytest.raises(psycopg.errors.InvalidParameterValue):  # an old purge: no more audit rows
        _as_worker(db, "SELECT retention_purge_audit(%s, 'k', 30)", mid)


def test_functions_are_not_public(db: str) -> None:
    rows = _q(db, "SELECT r, has_function_privilege(r, 'quota_reconcile_wallets(uuid)', 'EXECUTE'),"
              " has_function_privilege(r, 'retention_purge_audit(uuid,text,integer)', 'EXECUTE') "
              "FROM unnest(ARRAY['ricotdin_app', 'ricotdin_service', 'public']) r")  # fmt: skip
    assert all(not a and not b for _, a, b in rows)


def test_downgrade_removes_0006() -> None:
    with scratch_database("wsched_down") as url:
        alembic_upgrade(url)
        alembic_downgrade(url, "0005_worker_grants")
        assert _q(url, "SELECT to_regclass('public.scheduler_runs'), "
                  "to_regprocedure('quota_reconcile_wallets(uuid)')") == [(None, None)]  # fmt: skip
