# ruff: noqa: F811 - pytest fixtures imported from the runner tests are parameters here
"""ARC-08e: the scheduler lease and the four periodic tasks against a scratch database through
the worker login (fake Drive, fake provider endpoints)."""

import json
import shutil
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

import anyio
import httpx2
import psycopg
import pytest

from app.core.settings import Settings
from app.db.session import Database
from app.services.crypto import encrypt_with_key
from app.services.platform import Platform
from app.worker.schedule import TASKS, Scheduler
from app.worker.tasks.keyhealth import run_key_health
from app.worker.tasks.maintenance import run_stuck_meetings, run_wallet_reconcile
from app.worker.tasks.retention import run_retention_purge
from tests.conftest import requires_db
from tests.test_worker_runner_integration import (  # noqa: F401 - fixtures
    MASTER,
    _job,
    _no_ready_jobs,
    _seed,
    _sql,
    world,
)

pytestmark = [
    requires_db,
    pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed"),
]


def _with(world: dict[str, Any], body: Callable[[Database, Platform], Awaitable[Any]]) -> Any:
    settings = Settings.model_validate(
        {"DATABASE_URL_WORKER": world["worker"], "KEY_ENCRYPTION_SECRET": MASTER.hex()}
    )
    settings.db_pool_worker = (2, 0)

    async def go() -> Any:
        db = await Database.start(settings)
        platform = Platform.from_settings(settings, env={})
        platform.drive_transport = world["drive"].transport()
        try:
            return await body(db, platform)
        finally:
            await platform.aclose()
            await db.close()

    return anyio.run(go)


def _reset_tasks(world: dict[str, Any]) -> None:
    _sql(world["db"], "UPDATE scheduler_runs SET last_started_at = NULL, lease_owner = NULL, "
         "lease_until = NULL, last_status = NULL")  # fmt: skip


# --- lease --------------------------------------------------------------------------------------


def test_two_workers_never_run_the_same_task_and_due_survives(world: dict[str, Any]) -> None:
    _reset_tasks(world)
    calls: list[str] = []

    def runners(tag: str) -> dict[str, Any]:
        async def run() -> dict[str, int]:
            calls.append(tag)
            return {"n": 1}

        return dict.fromkeys(TASKS, run)

    async def body(db: Database, platform: Platform) -> tuple[list[str], list[str]]:
        a = Scheduler(db, platform, "worker-a", runners=runners("a"))
        b = Scheduler(db, platform, "worker-b", runners=runners("b"))
        return await a.run_due(), await b.run_due()

    ran_a, ran_b = _with(world, body)
    assert ran_a == list(TASKS) and ran_b == [] and calls == ["a"] * 4
    rows = _sql(world["db"], "SELECT task, last_status, last_detail, lease_owner FROM "
                "scheduler_runs ORDER BY task")  # fmt: skip
    assert all(r[1:] == ("ok", "n=1", None) for r in rows)
    # A crashed worker's lease expires; a 5-minute task is due again after its interval.
    _sql(world["db"], "UPDATE scheduler_runs SET last_started_at = now() - interval '6 minutes', "
         "lease_owner = 'dead', lease_until = now() - interval '1 second' "
         "WHERE task = 'stuck_meetings'")  # fmt: skip
    calls.clear()
    ran = _with(world, lambda db, p: Scheduler(db, p, "worker-b", runners=runners("b")).run_due())
    assert ran == ["stuck_meetings"] and calls == ["b"]


def test_a_failing_task_is_recorded_and_the_others_still_run(world: dict[str, Any]) -> None:
    _reset_tasks(world)

    async def boom() -> dict[str, int]:
        raise RuntimeError("secret detail")

    async def ok() -> dict[str, int]:
        return {}

    runners = {"key_health": boom, "retention_purge": ok, "wallet_reconcile": ok,
               "stuck_meetings": ok}  # fmt: skip
    ran = _with(world, lambda db, p: Scheduler(db, p, "w", runners=runners).run_due())
    assert ran == list(TASKS)
    assert _sql(world["db"], "SELECT last_status, last_detail FROM scheduler_runs WHERE task = "
                "'key_health'") == [("error", "RuntimeError")]  # fmt: skip


# --- key health ------------------------------------------------------------------------------------


def _key(world: dict[str, Any], config_key: str, plain: str | None, status: str = "active") -> Any:
    sec = encrypt_with_key(plain or "x", MASTER if plain else bytes(32))
    return _sql(
        world["db"],
        "INSERT INTO admin_config (config_key, label, value_ciphertext, value_iv, value_auth_tag, "
        "last4, status) VALUES (%s, 'k', %s, %s, %s, 'abcd', %s) RETURNING id",
        config_key, sec.ciphertext, sec.iv, sec.auth_tag, status,
    )[0][0]  # fmt: skip


def test_key_health_probes_every_key_without_putting_it_in_a_url(world: dict[str, Any]) -> None:
    _sql(world["db"], "DELETE FROM admin_config")
    good = _key(world, "gemini_api_key", "gem-ok")
    dead = _key(world, "openai_api_key", "oa-dead", status="disabled")
    grok = _key(world, "grok_api_key", "xai-ok")
    garbled = _key(world, "speechmatics_api_key", None)  # encrypted with another secret
    seen: list[httpx2.Request] = []

    def handle(request: httpx2.Request) -> httpx2.Response:
        request.read()
        seen.append(request)
        if request.url.host == "api.openai.com":
            return httpx2.Response(401)
        if request.url.host == "api.x.ai":
            return httpx2.Response(429)
        return httpx2.Response(200, json={})

    counts = _with(
        world, lambda db, p: run_key_health(db, p, transport=httpx2.MockTransport(handle))
    )
    assert counts == {"healthy": 2, "unhealthy": 2, "unknown": 0}
    status = dict(
        (r[0], (r[1], r[2] is not None))
        for r in _sql(world["db"], "SELECT id, health_status, health_checked_at FROM admin_config")
    )
    assert status == {good: ("healthy", True), dead: ("unhealthy", True),
                      grok: ("healthy", True), garbled: ("unhealthy", True)}  # fmt: skip
    for r in seen:
        assert not any(s in str(r.url) for s in ("gem-ok", "oa-dead", "xai-ok"))
    assert {r.url.host for r in seen} == {"generativelanguage.googleapis.com", "api.openai.com",
                                          "api.x.ai"}  # fmt: skip


# --- retention purge ----------------------------------------------------------------------------------


def test_retention_is_off_by_default(world: dict[str, Any]) -> None:
    _sql(
        world["db"],
        "UPDATE app_config SET value = 'null' WHERE key = 'storage.audio_retention_days'",
    )
    counts = _with(world, lambda db, p: run_retention_purge(db, p, datetime.now(UTC)))
    assert counts == {"purged": 0, "failed": 0, "skipped": 0}


def test_retention_purges_only_old_done_owned_drive_audio(world: dict[str, Any]) -> None:
    _sql(
        world["db"], "UPDATE app_config SET value = '30' WHERE key = 'storage.audio_retention_days'"
    )
    old = _seed(world, status="done")
    recent = _seed(world, status="done")
    failed = _seed(world, status="failed")
    forged = _seed(world, status="done", audio_path=f"{uuid.uuid4()}/{uuid.uuid4()}.webm")
    v1 = _seed(world, status="done", provider="r2")
    for case in (old, failed, forged, v1):
        _sql(world["db"], "UPDATE meetings SET created_at = now() - interval '40 days' "
             "WHERE id = %s", case.meeting)  # fmt: skip
    file_id = _sql(world["db"], "SELECT file_id FROM storage_objects WHERE key = %s", old.key)[0][0]
    try:
        counts = _with(world, lambda db, p: run_retention_purge(db, p, datetime.now(UTC)))
    finally:
        _sql(world["db"], "UPDATE app_config SET value = 'null' "
             "WHERE key = 'storage.audio_retention_days'")  # fmt: skip
    assert counts["purged"] >= 1
    assert _sql(world["db"], "SELECT audio_path, audio_purged_at IS NOT NULL FROM meetings "
                "WHERE id = %s", old.meeting) == [(None, True)]  # fmt: skip
    assert file_id not in world["drive"].files
    assert _sql(world["db"], "SELECT 1 FROM storage_objects WHERE key = %s", old.key) == []
    audit = _sql(world["db"], "SELECT actor_id, actor_email, action, metadata->>'retention_days' "
                 "FROM audit_logs WHERE target_id = %s", str(old.meeting))  # fmt: skip
    assert audit == [(None, "system:retention", "meeting.audio_purged", "30")]
    for case in (recent, failed, forged, v1):
        assert _sql(world["db"], "SELECT audio_path IS NOT NULL FROM meetings WHERE id = %s",
                    case.meeting) == [(True,)]  # fmt: skip
    # Transcripts and notes are never touched; a second run finds nothing more for this meeting.
    again = _with(world, lambda db, p: run_retention_purge(db, p, datetime.now(UTC)))
    assert again["purged"] == 0


# --- wallet reconcile / stuck meetings ---------------------------------------------------------------


def test_wallet_reconcile_fixes_a_drift(world: dict[str, Any]) -> None:
    case = _seed(world, balance=100)
    _sql(world["db"], "INSERT INTO quota_ledger (user_id, delta_audio_seconds, reason, dedup_key) "
         "VALUES (%s, 100, 'topup', %s)", case.user, f"topup:{case.user}")  # fmt: skip
    _sql(world["db"], "UPDATE quota_wallets SET audio_seconds_remaining = 7 WHERE user_id = %s",
         case.user)  # fmt: skip
    counts = _with(world, lambda db, p: run_wallet_reconcile(db))
    assert counts["drifted"] >= 1
    assert _sql(world["db"], "SELECT audio_seconds_remaining FROM quota_wallets WHERE user_id = %s",
                case.user) == [(100,)]  # fmt: skip


def test_v1_meetings_never_starve_the_purge(world: dict[str, Any]) -> None:
    _sql(
        world["db"], "UPDATE app_config SET value = '30' WHERE key = 'storage.audio_retention_days'"
    )
    v1_rows = [_seed(world, status="done", provider="r2", mapped=False) for _ in range(3)]
    target = _seed(world, status="done")
    busy = _seed(world, status="done")
    _job(world, busy, step="start")  # a reprocess is queued: its audio is needed
    for case in [*v1_rows, target, busy]:
        _sql(world["db"], "UPDATE meetings SET created_at = now() - interval '400 days' "
             "WHERE id = %s", case.meeting)  # fmt: skip
    try:
        import app.worker.tasks.retention as retention

        old = retention.PURGE_BATCH_LIMIT
        retention.PURGE_BATCH_LIMIT = 1  # a batch the v1 rows would fill if they were selected
        try:
            counts = _with(world, lambda db, p: run_retention_purge(db, p, datetime.now(UTC)))
        finally:
            retention.PURGE_BATCH_LIMIT = old
    finally:
        _sql(world["db"], "UPDATE app_config SET value = 'null' "
             "WHERE key = 'storage.audio_retention_days'")  # fmt: skip
    assert counts["purged"] == 1
    assert _sql(world["db"], "SELECT audio_path FROM meetings WHERE id = %s", target.meeting) == [
        (None,)
    ]
    assert _sql(world["db"], "SELECT audio_path IS NOT NULL FROM meetings WHERE id = %s",
                busy.meeting) == [(True,)]  # fmt: skip


def test_stuck_meetings_without_a_job_fail(world: dict[str, Any]) -> None:
    orphan = _seed(world, status="processing")
    busy = _seed(world, status="processing")
    fresh = _seed(world, status="processing")
    _job(world, busy, step="analyse")
    with psycopg.connect(world["db"], autocommit=True) as conn:
        conn.execute("SET session_replication_role = replica")  # the updated_at trigger is off
        conn.execute(
            "UPDATE meetings SET updated_at = now() - interval '45 minutes' WHERE id = ANY(%s)",
            ([orphan.meeting, busy.meeting],),
        )
    counts = _with(world, lambda db, p: run_stuck_meetings(db))
    assert counts["failed"] >= 1
    status = dict(_sql(world["db"], "SELECT id, status FROM meetings WHERE id IN (%s, %s, %s)",
                       orphan.meeting, busy.meeting, fresh.meeting))  # fmt: skip
    assert status == {orphan.meeting: "failed", busy.meeting: "processing",
                      fresh.meeting: "processing"}  # fmt: skip
    events = _sql(world["db"], "SELECT event_type, metadata->>'reason' FROM activity_log "
                  "WHERE meeting_id = %s", orphan.meeting)  # fmt: skip
    assert events == [("processing_failed", "stuck_meeting")]
    assert json.dumps(counts)
