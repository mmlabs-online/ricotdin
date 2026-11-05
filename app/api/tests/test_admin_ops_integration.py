# ruff: noqa: F811 - pytest fixtures imported from other integration tests are parameters here
"""ARC-10b: ``/admin/{pipeline,usage,ai-usage,activity,audit-logs}`` end to end (scratch
database, the real API). 403 for non-admins; never meeting content; requeue (failed / stuck
only) queues one job without clearing anything and writes one audit row; filters and paging."""

import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

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
    ("GET", "/admin/pipeline/overview"), ("GET", "/admin/pipeline/jobs"),
    ("POST", "/admin/pipeline/{id}/requeue"), ("GET", "/admin/pipeline/schedulers"),
    ("GET", "/admin/usage"), ("GET", "/admin/ai-usage"), ("GET", "/admin/activity"),
    ("GET", "/admin/audit-logs"),
]  # fmt: skip


def _meeting(world: dict[str, Any], status: str = "done", *, audio: bool = True,
             mapped: bool = True, age_min: int = 0) -> uuid.UUID:  # fmt: skip
    mid = uuid.uuid4()
    key = f"{world['b']}/{mid}.webm" if audio else None
    _sql(world["db"], "INSERT INTO meetings (id, user_id, status, audio_path, summary, notes, "
         "title) VALUES (%s, %s, %s, %s, 'SECRET SUMMARY', 'SECRET NOTES', 'T')",
         mid, world["b"], status, key)  # fmt: skip
    if audio and mapped:
        _sql(world["db"], "INSERT INTO storage_objects (key, file_id, size_bytes, content_type) "
             "VALUES (%s, %s, 1000, 'audio/webm')", key, f"f{secrets.token_hex(6)}")  # fmt: skip
    if age_min:
        import psycopg

        with psycopg.connect(world["db"], autocommit=True) as conn:
            conn.execute("SET session_replication_role = replica")  # keep the old updated_at
            conn.execute("UPDATE meetings SET updated_at = now() - make_interval(mins => %s) "
                         "WHERE id = %s", (age_min, mid))  # fmt: skip
    return mid


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_non_admins_get_403(
    client: TestClient, world: dict[str, Any], admin: dict[str, str], method: str, path: str
) -> None:
    mid = _meeting(world, "failed")
    url = path.format(id=mid)
    assert client.request(method, url, headers=_as(client, "b")).status_code == 403
    demoted = _new_user(world)
    assert client.request(method, url, headers=_token(client, demoted, "admin")).status_code == 403
    assert _sql(world["db"], "SELECT count(*) FROM jobs WHERE meeting_id = %s", mid) == [(0,)]


# --- pipeline -------------------------------------------------------------------------------------


def test_overview_and_jobs_never_show_content(
    client: TestClient, world: dict[str, Any], admin: dict[str, str]
) -> None:
    stuck = _meeting(world, "processing", age_min=20)
    fresh = _meeting(world, "processing")
    polling = _meeting(world, "processing", age_min=40)  # a long transcription: job still active
    _sql(world["db"], "INSERT INTO jobs (meeting_id, step, status) VALUES (%s, 'transcribe_poll', "
         "'queued')", polling)  # fmt: skip
    overview = client.get("/admin/pipeline/overview", headers=admin).json()
    assert overview["counts"]["stuck"] >= 1 and overview["stuck_threshold_minutes"] == 15
    assert overview["total"] >= 2
    r = client.get("/admin/pipeline/jobs?status=stuck&perPage=100", headers=admin)
    assert r.status_code == 200
    ids = {j["id"] for j in r.json()["jobs"]}
    assert str(stuck) in ids and str(fresh) not in ids and str(polling) not in ids
    processing = client.get("/admin/pipeline/jobs?status=processing&perPage=100",
                            headers=admin).json()["jobs"]  # fmt: skip
    flags = {j["id"]: j["is_stuck"] for j in processing}
    assert flags[str(stuck)] is True and flags[str(polling)] is False  # same rule as the count
    assert all(j["is_stuck"] for j in r.json()["jobs"])
    assert "SECRET" not in r.text
    row = next(j for j in r.json()["jobs"] if j["id"] == str(stuck))
    assert row["owner_email"].endswith("@example.test") and row["job"] is None
    assert client.get("/admin/pipeline/jobs?status=nope", headers=admin).status_code == 400


def test_requeue_keeps_output_and_queues_one_job(
    client: TestClient, world: dict[str, Any], admin: dict[str, str]
) -> None:
    mid = _meeting(world, "failed")
    _sql(world["db"], "INSERT INTO transcript_segments (meeting_id, segment_index, start_ms, "
         "end_ms, text) VALUES (%s, 0, 0, 1, 'x')", mid)  # fmt: skip
    _sql(world["db"], "INSERT INTO todos (meeting_id, content) VALUES (%s, 'x')", mid)
    r = client.post(f"/admin/pipeline/{mid}/requeue", headers=admin)
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "meetingId": str(mid)}
    # v2: nothing is cleared here; the worker replaces the output only when the re-run succeeds
    assert _sql(world["db"], "SELECT status, summary FROM meetings WHERE id = %s", mid) == [
        ("pending", "SECRET SUMMARY")
    ]
    for table in ("transcript_segments", "todos"):
        assert _sql(world["db"], f"SELECT count(*) FROM {table} WHERE meeting_id = %s", mid) == [  # noqa: S608
            (1,)
        ]
    assert _sql(world["db"], "SELECT step, status FROM jobs WHERE meeting_id = %s", mid) == [
        ("start", "queued")
    ]
    (audit,) = _sql(world["db"], "SELECT action, metadata FROM audit_logs WHERE target_id = %s",
                    str(mid))  # fmt: skip
    assert audit[0] == "meeting.requeue" and audit[1]["previous_status"] == "failed"
    again = client.post(f"/admin/pipeline/{mid}/requeue", headers=admin)
    assert again.status_code == 409 and _msg(again) == (
        "A job for this meeting is still queued or running."
    )
    jobs = client.get("/admin/pipeline/jobs?status=pending&perPage=100", headers=admin).json()
    row = next(j for j in jobs["jobs"] if j["id"] == str(mid))
    assert row["job"]["status"] == "queued" and row["job"]["step"] == "start"


def test_requeue_refusals(client: TestClient, world: dict[str, Any], admin: dict[str, str]) -> None:
    purged = _meeting(world, "failed", audio=False)
    # done / a live processing meeting: only failed or stuck ones (v1 §9d)
    for status in ("done", "processing"):
        healthy = _meeting(world, status)
        r = client.post(f"/admin/pipeline/{healthy}/requeue", headers=admin)
        assert r.status_code == 422 and _msg(r) == "Only failed or stuck meetings can be requeued."
        assert _sql(world["db"], "SELECT status FROM meetings WHERE id = %s", healthy) == [
            (status,)
        ]
    stuck = _meeting(world, "processing", age_min=20)
    assert client.post(f"/admin/pipeline/{stuck}/requeue", headers=admin).status_code == 200
    r = client.post(f"/admin/pipeline/{purged}/requeue", headers=admin)
    assert r.status_code == 409 and "no audio" in _msg(r)
    uploading = _meeting(world, "pending", mapped=False)
    assert client.post(f"/admin/pipeline/{uploading}/requeue", headers=admin).status_code == 422
    # the worker could not run these: refused before anything changes
    missing = _meeting(world, "failed", mapped=False)
    r = client.post(f"/admin/pipeline/{missing}/requeue", headers=admin)
    assert r.status_code == 409 and "missing from storage" in _msg(r)
    v1 = _meeting(world, "failed")
    _sql(world["db"], "UPDATE meetings SET storage_provider = 'r2' WHERE id = %s", v1)
    r = client.post(f"/admin/pipeline/{v1}/requeue", headers=admin)
    assert r.status_code == 409 and "not been copied" in _msg(r)
    forged = _meeting(world, "failed")
    _sql(world["db"], "UPDATE meetings SET audio_path = %s WHERE id = %s",
         f"{world['c']}/{uuid.uuid4()}.webm", forged)  # fmt: skip
    assert client.post(f"/admin/pipeline/{forged}/requeue", headers=admin).status_code == 409
    for mid in (missing, v1, forged):
        assert _sql(world["db"], "SELECT status FROM meetings WHERE id = %s", mid) == [("failed",)]
        assert _sql(world["db"], "SELECT count(*) FROM jobs WHERE meeting_id = %s", mid) == [(0,)]
    assert client.post(f"/admin/pipeline/{uuid.uuid4()}/requeue",
                       headers=admin).status_code == 404  # fmt: skip
    assert client.post("/admin/pipeline/nope/requeue", headers=admin).status_code == 404


def test_schedulers(client: TestClient, world: dict[str, Any], admin: dict[str, str]) -> None:
    _sql(world["db"], "UPDATE scheduler_runs SET last_finished_at = now(), last_status = 'ok' "
         "WHERE task = 'wallet_reconcile'")  # fmt: skip
    tasks = {t["task"]: t for t in client.get("/admin/pipeline/schedulers",
                                              headers=admin).json()["tasks"]}  # fmt: skip
    assert set(tasks) == {"key_health", "retention_purge", "wallet_reconcile", "stuck_meetings"}
    assert tasks["wallet_reconcile"]["stale"] is False and tasks["key_health"]["stale"] is True
    assert tasks["wallet_reconcile"]["every_seconds"] == 300


# --- usage ----------------------------------------------------------------------------------------


def test_usage(client: TestClient, world: dict[str, Any], admin: dict[str, str]) -> None:
    _meeting(world, "failed")
    body = client.get("/admin/usage", headers=admin).json()
    assert body["meetings"]["total"] == sum(body["meetings"]["byStatus"].values())
    assert body["meetings"]["byStatus"]["failed"] >= 1 and 0 < body["meetings"]["failureRate"] <= 1
    assert body["storage"]["fileCount"] >= 1 and body["storage"]["totalBytes"] >= 1000


def test_ai_usage_keeps_units_apart_and_masks_keys(
    client: TestClient, world: dict[str, Any], admin: dict[str, str]
) -> None:
    key_id = uuid.uuid4()
    _sql(world["db"], "INSERT INTO admin_config (id, config_key, label, value_ciphertext, "
         "value_iv, value_auth_tag, status, last4) VALUES (%s, 'openai_api_key', 'main', "
         "'CIPHERTEXT', 'IV', 'TAG', 'active', 'ab12')", key_id)  # fmt: skip
    uid = _new_user(world)
    _sql(world["db"], "INSERT INTO usage_log (provider, model, operation, unit, quantity, "
         "input_tokens, output_tokens, total_tokens, status, user_id, key_id) VALUES "
         "('openai', 'gpt-4o', 'chat', 'tokens', 10, 4, 6, 10, 'ok', %s, %s), "
         "('openai', 'gpt-4o', 'chat', 'tokens', 5, 2, 3, 5, 'rate_limited', %s, %s)",
         uid, key_id, uid, key_id)  # fmt: skip
    _sql(world["db"], "INSERT INTO usage_log (provider, model, operation, unit, quantity, "
         "audio_seconds, status, user_id) VALUES ('speechmatics', 'enhanced', 'transcribe', "
         "'audio_seconds', 30.5, 30.5, 'error', %s)", uid)  # fmt: skip
    r = client.get(f"/admin/ai-usage?userId={uid}&groupBy=operation", headers=admin)
    assert r.status_code == 200, r.text
    assert "CIPHERTEXT" not in r.text and "IV" not in r.text.replace("IVE", "")
    rows = {row["provider"]: row for row in r.json()["rows"]}
    gpt, sm = rows["openai"], rows["speechmatics"]
    assert (gpt["calls"], gpt["total_tokens"], gpt["total_input_tokens"]) == (2, 15, 6)
    assert gpt["total_audio_seconds"] is None and gpt["rate_limited_count"] == 1
    assert (gpt["key_label"], gpt["key_last4"], gpt["operation"]) == ("main", "ab12", "chat")
    assert sm["total_audio_seconds"] == 30.5 and sm["total_tokens"] is None
    assert sm["error_count"] == 1
    daily = {(d["provider"], d["unit"]): d["quantity"] for d in r.json()["dailyTotals"]}
    assert daily == {("openai", "tokens"): 15, ("speechmatics", "audio_seconds"): 30.5}
    bad = client.get("/admin/ai-usage?from=2026-10-02&to=2026-10-01", headers=admin)
    assert bad.status_code == 400
    assert client.get("/admin/ai-usage?userId=x", headers=admin).status_code == 400


# --- activity + audit -----------------------------------------------------------------------------


def test_activity_feed_filters(
    client: TestClient, world: dict[str, Any], admin: dict[str, str]
) -> None:
    uid = _new_user(world)
    mid = _meeting(world)
    _sql(world["db"], "INSERT INTO activity_log (user_id, event_type, meeting_id, metadata, "
         "created_at) VALUES (%s, 'chat_message', %s, '{\"k\": 1}', now()), "
         "(%s, 'login', NULL, NULL, now() - interval '3 days')", uid, mid, uid)  # fmt: skip
    body = client.get(f"/admin/activity?userId={uid}", headers=admin).json()
    assert body["total"] == 2 and body["rows"][0]["event_type"] == "chat_message"
    assert body["rows"][0]["meeting_title"] == "T" and body["rows"][0]["metadata"] == {"k": 1}
    # the feed names the user (ARC-14b): the account's email, read like the audit actor
    email = _sql(world["db"], "SELECT email FROM users WHERE id = %s", uid)[0][0]
    assert body["rows"][0]["user_email"] == email
    assert "SECRET" not in str(body)
    only = client.get(f"/admin/activity?userId={uid}&eventType=login", headers=admin).json()
    assert only["total"] == 1
    today = datetime.now(UTC).date().isoformat()
    recent = client.get(f"/admin/activity?userId={uid}&from={today}&to={today}",
                        headers=admin).json()  # fmt: skip
    assert recent["total"] == 1
    paged = client.get(f"/admin/activity?userId={uid}&perPage=1&page=2", headers=admin).json()
    assert len(paged["rows"]) == 1 and paged["rows"][0]["event_type"] == "login"


def test_audit_log_filters(
    client: TestClient, world: dict[str, Any], admin: dict[str, str]
) -> None:
    target = _new_user(world)
    client.patch(f"/admin/users/{target}/status", headers=admin, json={"disabled": True})
    client.post(f"/admin/users/{target}/quota", headers=admin, json={"agent_queries": 1})
    logs = client.get(f"/admin/audit-logs?actor={world['a']}&action=user.&perPage=100",
                      headers=admin).json()  # fmt: skip
    actions = {entry["action"] for entry in logs["logs"] if entry["target_id"] == str(target)}
    assert actions == {"user.disable"}  # the prefix excludes quota.grant
    assert all(entry["actor_id"] == str(world["a"]) for entry in logs["logs"])
    # wildcards are literal: `user_` must not match `user.`
    assert client.get("/admin/audit-logs?action=user_", headers=admin).json()["total"] == 0
    tomorrow = (datetime.now(UTC) + timedelta(days=1)).date().isoformat()
    assert client.get(f"/admin/audit-logs?from={tomorrow}", headers=admin).json()["total"] == 0
    assert client.get("/admin/audit-logs?actor=root", headers=admin).status_code == 400
