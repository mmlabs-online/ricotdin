"""Admin operations (ARC-10b; port of v1 ``app/api/admin/{pipeline,usage,ai-usage,activity,
audit-logs}``, CLAUDE.md §9d, §9e, §9g). Reads as ``ricotdin_service``; only requeue writes.

Never returned: meeting content (summary, notes, transcript), ciphertext or keys. Requeue clears
the previous output and queues ONE job (the same unique index as ``/process``) with an audit row
in the same transaction. v1's manual ``reconcile-quota`` is replaced by the worker's 5-minute
``wallet_reconcile`` / ``stuck_meetings`` tasks (ARC-08e); ``GET /admin/pipeline/schedulers``
shows their state and flags a stale one.
"""

from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy import text

from app.core.errors import Conflict, NotFound
from app.db.session import Database, get_database
from app.domain.admin import like_pattern, parse_list_params
from app.domain.admin_ops import (
    STUCK_MINUTES,
    is_stale_task,
    is_stuck,
    parse_activity_filters,
    parse_audit_filters,
    parse_pipeline_filter,
    parse_usage_range,
)
from app.domain.rules import can_reprocess
from app.routers._common import SERVICE, jsonb, path_id
from app.routers.admin._common import CurrentAdmin, write_audit
from app.worker.schedule import TASKS

router = APIRouter(prefix="/admin", tags=["admin"])
Db = Annotated[Database, Depends(get_database)]

_MEETING_NOT_FOUND = "Meeting not found."
_NO_AUDIO = (
    "This meeting has no audio (deleted by the retention policy), so it cannot be reprocessed."
)
_BUSY = "A job for this meeting is still queued or running."
_UPLOADING = "This meeting is still being uploaded."
_QUEUE_JOB = (
    "INSERT INTO public.jobs (meeting_id, step, status, run_after, payload) "
    "VALUES (:id, 'start', 'queued', now(), '{}'::jsonb) "
    "ON CONFLICT (meeting_id) WHERE status IN ('queued', 'running') DO NOTHING RETURNING id"
)


def _now() -> datetime:
    return datetime.now(UTC)


# --- pipeline -------------------------------------------------------------------------------------


@router.get("/pipeline/overview")
async def pipeline_overview(admin: CurrentAdmin, db: Db) -> dict[str, Any]:
    async with db.role_transaction(SERVICE) as conn:
        row = (
            await conn.execute(
                text(
                    "SELECT count(*) AS total, "
                    "count(*) FILTER (WHERE status = 'pending') AS pending, "
                    "count(*) FILTER (WHERE status = 'processing') AS processing, "
                    "count(*) FILTER (WHERE status = 'done') AS done, "
                    "count(*) FILTER (WHERE status = 'failed') AS failed, "
                    "count(*) FILTER (WHERE status = 'processing' AND updated_at < :cut) "
                    "AS stuck, "
                    "avg(extract(epoch FROM updated_at - created_at)) FILTER (WHERE status = "
                    "'done' AND updated_at > created_at) AS avg_secs "
                    "FROM public.meetings"
                ),
                {"cut": _now() - timedelta(minutes=STUCK_MINUTES)},
            )
        ).one()
    return {
        "counts": {k: int(getattr(row, k)) for k in ("pending", "processing", "done", "failed",
                                                     "stuck")},
        "avg_processing_secs": round(float(row.avg_secs)) if row.avg_secs is not None else None,
        "stuck_threshold_minutes": STUCK_MINUTES,
        "total": int(row.total),
    }  # fmt: skip


@router.get("/pipeline/jobs")
async def pipeline_jobs(request: Request, admin: CurrentAdmin, db: Db) -> dict[str, Any]:
    """``?status=pending|processing|done|failed|stuck&page&perPage``: meeting metadata only
    (never summary, notes or transcript), the owner, and the latest job's state."""
    status = parse_pipeline_filter(request.query_params.get("status"))
    paging = parse_list_params(request.query_params)
    now = _now()
    where = "TRUE"
    args: dict[str, Any] = {"cut": now - timedelta(minutes=STUCK_MINUTES)}
    if status == "stuck":
        where = "m.status = 'processing' AND m.updated_at < :cut"
    elif status:
        where, args = "m.status = :st", {**args, "st": status}
    async with db.role_transaction(SERVICE) as conn:
        total = (
            await conn.execute(
                text(f"SELECT count(*) FROM public.meetings m WHERE {where}"),  # noqa: S608
                args,
            )
        ).scalar_one()
        rows = (
            await conn.execute(
                text(
                    "SELECT m.id, m.title, m.status, m.created_at, m.updated_at, "  # noqa: S608
                    "m.duration_seconds, m.error_message, m.user_id, u.email, p.username, "
                    "j.status AS job_status, j.step AS job_step, j.attempts AS job_attempts, "
                    "left(j.last_error, 500) AS job_error "
                    "FROM public.meetings m "
                    "LEFT JOIN public.users u ON u.id = m.user_id "
                    "LEFT JOIN public.profiles p ON p.id = m.user_id "
                    "LEFT JOIN LATERAL (SELECT status, step, attempts, last_error FROM "
                    "public.jobs WHERE meeting_id = m.id ORDER BY created_at DESC, id DESC "
                    "LIMIT 1) j ON true "
                    f"WHERE {where} ORDER BY m.created_at DESC, m.id LIMIT :lim OFFSET :off"
                ),
                {**args, "lim": paging.per_page, "off": (paging.page - 1) * paging.per_page},
            )
        ).all()
    jobs = [
        {"id": r.id, "title": r.title, "status": r.status, "created_at": r.created_at,
         "updated_at": r.updated_at, "duration_seconds": r.duration_seconds,
         "error_message": r.error_message, "owner_email": r.email,
         "owner_username": r.username, "is_stuck": is_stuck(r.status, r.updated_at, now),
         "job": None if r.job_status is None else {
             "status": r.job_status, "step": r.job_step, "attempts": r.job_attempts,
             "last_error": r.job_error}}
        for r in rows
    ]  # fmt: skip
    return {"jobs": jobs, "total": total, "page": paging.page, "perPage": paging.per_page}


@router.post("/pipeline/{meeting_id}/requeue")
async def requeue(meeting_id: str, admin: CurrentAdmin, db: Db) -> dict[str, Any]:
    """Re-run a meeting from the start (v1): previous transcript, chunks, to-dos and calendar
    suggestions are cleared, the meeting goes back to ``pending`` and one job is queued (a new
    job = a new quota charge, CLAUDE.md §0.7). 409 without audio, while a job is queued or running
    (the stuck sweep releases a stuck one) and while the upload is not confirmed."""
    mid = path_id(meeting_id, _MEETING_NOT_FOUND)
    async with db.role_transaction(SERVICE) as conn:
        meeting = (
            await conn.execute(
                text(
                    "SELECT m.id, m.user_id, m.status, m.audio_path, EXISTS (SELECT 1 FROM "
                    "public.storage_objects o WHERE o.key = m.audio_path) AS mapped, "
                    "EXISTS (SELECT 1 FROM public.jobs j WHERE j.meeting_id = m.id AND "
                    "j.status IN ('queued', 'running')) AS active "
                    "FROM public.meetings m WHERE m.id = :id FOR NO KEY UPDATE OF m"
                ),
                {"id": mid},
            )
        ).first()
        if meeting is None:
            raise NotFound(_MEETING_NOT_FOUND)
        if not can_reprocess(meeting.audio_path):
            raise Conflict(_NO_AUDIO)
        if meeting.active:
            raise Conflict(_BUSY)
        if meeting.status == "pending" and not meeting.mapped:
            raise Conflict(_UPLOADING)
        for table in ("transcript_chunks", "transcript_segments", "todos", "calendar_suggestions"):
            await conn.execute(
                text(f"DELETE FROM public.{table} WHERE meeting_id = :id"),  # noqa: S608
                {"id": mid},
            )
        await conn.execute(
            text(
                "UPDATE public.meetings SET status = 'pending', error_message = NULL, "
                "summary = NULL, notes = NULL, language = NULL WHERE id = :id"
            ),
            {"id": mid},
        )
        job = (await conn.execute(text(_QUEUE_JOB), {"id": mid})).scalar_one_or_none()
        if job is None:  # a job was queued concurrently
            raise Conflict(_BUSY)
        await write_audit(conn, admin, "meeting.requeue", "meeting", str(mid),
                          {"previous_status": meeting.status,
                           "meeting_owner_id": str(meeting.user_id),
                           "job_id": str(job)})  # fmt: skip
    return {"ok": True, "meetingId": mid}


@router.get("/pipeline/schedulers")
async def schedulers(admin: CurrentAdmin, db: Db) -> dict[str, Any]:
    """The worker's periodic tasks (ARC-08e): last run, status, short detail, and ``stale`` when
    a task has not finished for two intervals (stopped worker or a poisoned lease)."""
    async with db.role_transaction(SERVICE) as conn:
        rows = (
            await conn.execute(
                text(
                    "SELECT task, last_started_at, last_finished_at, last_status, last_detail, "
                    "lease_until FROM public.scheduler_runs ORDER BY task"
                )
            )
        ).all()
    now = _now()
    return {
        "tasks": [
            {"task": r.task, "every_seconds": TASKS.get(r.task), "last_started_at":
             r.last_started_at, "last_finished_at": r.last_finished_at,
             "last_status": r.last_status, "last_detail": r.last_detail,
             "lease_until": r.lease_until,
             "stale": is_stale_task(r.last_finished_at, TASKS.get(r.task, 3600), now)}
            for r in rows
        ]
    }  # fmt: skip


# --- usage ----------------------------------------------------------------------------------------


@router.get("/usage")
async def usage(admin: CurrentAdmin, db: Db) -> dict[str, Any]:
    """Meeting counts by status / age and stored file totals (Drive map; v1 listed the bucket)."""
    now = _now()
    async with db.role_transaction(SERVICE) as conn:
        statuses = (
            await conn.execute(
                text("SELECT status, count(*) AS n FROM public.meetings GROUP BY status")
            )
        ).all()
        ages = (
            await conn.execute(
                text(
                    "SELECT count(*) FILTER (WHERE created_at >= :d7) AS d7, "
                    "count(*) FILTER (WHERE created_at >= :d30) AS d30 FROM public.meetings"
                ),
                {"d7": now - timedelta(days=7), "d30": now - timedelta(days=30)},
            )
        ).one()
        files = (
            await conn.execute(
                text(
                    "SELECT count(*) AS n, COALESCE(sum(size_bytes), 0) AS bytes "
                    "FROM public.storage_objects"
                )
            )
        ).one()
    by_status = {r.status: int(r.n) for r in statuses}
    total = sum(by_status.values())
    return {
        "meetings": {
            "total": total,
            "byStatus": by_status,
            "failureRate": by_status.get("failed", 0) / total if total else 0,
            "last7Days": int(ages.d7),
            "last30Days": int(ages.d30),
        },
        "storage": {"totalBytes": int(files.bytes), "fileCount": int(files.n)},
    }


@router.get("/ai-usage")
async def ai_usage(request: Request, admin: CurrentAdmin, db: Db) -> dict[str, Any]:
    """``?from&to&groupBy=operation&userId``: provider calls per provider / model / unit / key
    (and operation), tokens and audio seconds never summed together (CLAUDE.md §9e), plus daily
    totals per provider and unit. Key rows show only label and last 4 characters."""
    q = request.query_params
    start, end = parse_usage_range(q.get("from"), q.get("to"), _now())
    by_operation = q.get("groupBy") == "operation"
    filters = parse_activity_filters({"userId": q.get("userId")})
    where = "l.created_at >= :s AND l.created_at <= :e" + (
        " AND l.user_id = :u" if filters.user_id else ""
    )
    args: dict[str, Any] = {"s": start, "e": end, "u": filters.user_id}
    op = "l.operation" if by_operation else "NULL::text"
    async with db.role_transaction(SERVICE) as conn:
        rows = (
            await conn.execute(
                text(
                    f"SELECT l.provider, l.model, {op} AS operation, l.unit, l.key_id, "  # noqa: S608
                    "k.label AS key_label, k.last4 AS key_last4, count(*) AS calls, "
                    "sum(l.total_tokens) FILTER (WHERE l.unit = 'tokens') AS tot, "
                    "sum(l.input_tokens) FILTER (WHERE l.unit = 'tokens') AS inp, "
                    "sum(l.output_tokens) FILTER (WHERE l.unit = 'tokens') AS outp, "
                    "sum(l.audio_seconds) FILTER (WHERE l.unit = 'audio_seconds') AS secs, "
                    "count(*) FILTER (WHERE l.status = 'rate_limited') AS limited, "
                    "count(*) FILTER (WHERE l.status = 'error') AS errors "
                    "FROM public.usage_log l LEFT JOIN public.admin_config k ON k.id = l.key_id "
                    f"WHERE {where} GROUP BY 1, 2, 3, 4, 5, 6, 7 ORDER BY 1, 2, 3, 4, 5"
                ),
                args,
            )
        ).all()
        daily = (
            await conn.execute(
                text(
                    "SELECT to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, "  # noqa: S608
                    "l.provider, l.unit, sum(l.quantity) AS qty FROM public.usage_log l "
                    f"WHERE {where} GROUP BY 1, 2, 3 ORDER BY 1, 2, 3"
                ),
                args,
            )
        ).all()

    def num(v: Any, tokens: bool) -> float | int | None:
        if v is None:
            return None
        return int(v) if tokens else float(v)

    return {
        "from": start,
        "to": end,
        "rows": [
            {"provider": r.provider, "model": r.model, "operation": r.operation, "unit": r.unit,
             "key_id": r.key_id, "key_label": r.key_label, "key_last4": r.key_last4,
             "calls": int(r.calls),
             "total_tokens": num(r.tot, True) if r.unit == "tokens" else None,
             "total_input_tokens": num(r.inp, True) if r.unit == "tokens" else None,
             "total_output_tokens": num(r.outp, True) if r.unit == "tokens" else None,
             "total_audio_seconds": num(r.secs, False) if r.unit == "audio_seconds" else None,
             "rate_limited_count": int(r.limited), "error_count": int(r.errors)}
            for r in rows
        ],
        "dailyTotals": [
            {"date": r.day, "provider": r.provider, "unit": r.unit, "quantity": float(r.qty or 0)}
            for r in daily
        ],
    }  # fmt: skip


# --- activity + audit -----------------------------------------------------------------------------


@router.get("/activity")
async def activity(request: Request, admin: CurrentAdmin, db: Db) -> dict[str, Any]:
    """``?userId&eventType&from&to&page&perPage``: the activity feed with the meeting title
    (never meeting content)."""
    f = parse_activity_filters(request.query_params)
    clauses, args = [], {"u": f.user_id, "e": f.event_type, "s": f.start, "t": f.end}
    if f.user_id:
        clauses.append("a.user_id = :u")
    if f.event_type:
        clauses.append("a.event_type = :e")
    if f.start:
        clauses.append("a.created_at >= :s")
    if f.end:
        clauses.append("a.created_at < :t")
    where = " AND ".join(clauses) or "TRUE"
    async with db.role_transaction(SERVICE) as conn:
        total = (
            await conn.execute(
                text(f"SELECT count(*) FROM public.activity_log a WHERE {where}"),  # noqa: S608
                args,
            )
        ).scalar_one()
        rows = (
            await conn.execute(
                text(
                    "SELECT a.id, a.created_at, a.user_id, a.event_type, a.meeting_id, "  # noqa: S608
                    "m.title AS meeting_title, a.target_user_id, a.metadata, a.ip, a.user_agent "
                    "FROM public.activity_log a LEFT JOIN public.meetings m ON m.id = "
                    f"a.meeting_id WHERE {where} ORDER BY a.created_at DESC, a.id DESC "
                    "LIMIT :lim OFFSET :off"
                ),
                {**args, "lim": f.per_page, "off": (f.page - 1) * f.per_page},
            )
        ).all()
    return {
        "rows": [{**dict(r._mapping), "metadata": jsonb(r.metadata)} for r in rows],
        "total": total,
        "page": f.page,
        "perPage": f.per_page,
    }


@router.get("/audit-logs")
async def audit_logs(request: Request, admin: CurrentAdmin, db: Db) -> dict[str, Any]:
    """``?actor&action(prefix)&from&to&page&perPage``."""
    f = parse_audit_filters(request.query_params)
    clauses = []
    args: dict[str, Any] = {"a": f.actor, "s": f.start, "t": f.end}
    if f.actor:
        clauses.append("actor_id = :a")
    if f.action:
        clauses.append("action LIKE :p ESCAPE '\\'")
        args["p"] = like_pattern(f.action)[1:]  # prefix: drop the leading %
    if f.start:
        clauses.append("created_at >= :s")
    if f.end:
        clauses.append("created_at < :t")
    where = " AND ".join(clauses) or "TRUE"
    async with db.role_transaction(SERVICE) as conn:
        total = (
            await conn.execute(
                text(f"SELECT count(*) FROM public.audit_logs WHERE {where}"),  # noqa: S608
                args,
            )
        ).scalar_one()
        rows = (
            await conn.execute(
                text(
                    "SELECT id, actor_id, actor_email, action, target_type, target_id, "  # noqa: S608
                    "metadata, ip_address, user_agent, created_at FROM public.audit_logs "
                    f"WHERE {where} ORDER BY created_at DESC, id DESC LIMIT :lim OFFSET :off"
                ),
                {**args, "lim": f.per_page, "off": (f.page - 1) * f.per_page},
            )
        ).all()
    return {
        "logs": [{**dict(r._mapping), "metadata": jsonb(r.metadata)} for r in rows],
        "total": total,
        "page": f.page,
        "perPage": f.per_page,
    }
