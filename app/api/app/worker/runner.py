"""The job runner (ARC-08; port of v1 ``lib/jobs/worker.ts``, REL-01/02/03).

* ``run_once`` claims one job with ``claim_next_job`` (``FOR UPDATE SKIP LOCKED``: two workers
  never get the same job), runs its step handler in a private temp directory with a timeout and
  records the outcome. Every write to the job is guarded by ``status = 'running' AND
  locked_by = <this worker>``, so a job the sweeper took back is never overwritten.
* Errors: transient → queued again with jittered backoff until ``max_attempts``; terminal
  (``PipelineError``, typed 4xx) or exhausted → job failed, reserved quota refunded, meeting
  failed, activity ``processing_failed``.
* ``sweep_stuck`` takes back jobs running for longer than 15 min (a worker died): requeue, or
  fail like a terminal error (with refund + activity, owner decision 2026-11-02) when exhausted.
* ``run_forever`` polls every second when idle and sweeps every 60 s until ``stop`` is set; a
  cancelled job is released (queued again at once, attempts unchanged).

All SQL runs as ``ricotdin_worker`` (explicit allow-list, migration 0005).
"""

import json
import random
import shutil
import tempfile
import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import anyio
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.logging import get_logger
from app.core.sentry import capture_unhandled
from app.db.session import Database
from app.services.ai.service import AIService
from app.services.platform import Platform
from app.worker.backoff import jittered_backoff
from app.worker.errors import PipelineError, is_terminal
from app.worker.jobs import (
    Advance,
    Done,
    Fail,
    Job,
    Outcome,
    StepContext,
    StepHandler,
    Transcriber,
)
from app.worker.messages import (
    DEADLINE_EXCEEDED,
    GENERIC_FAILURE,
    JOB_STUCK_FAILED,
    MEETING_TIMED_OUT,
    activity_error,
    error_text,
    stuck_requeued_message,
    user_message,
)
from app.worker.policy import (
    POLL_INTERVAL_S,
    STEP_TIMEOUT_S,
    STUCK_THRESHOLD_S,
    SWEEP_INTERVAL_S,
    WORKDIR_PREFIX,
    ReportThrottle,
    deadline_exceeded,
    loop_error_backoff,
    retry_decision,
    stale_workdirs,
)

log = get_logger("worker")

WORKER = "ricotdin_worker"
_JOB_COLUMNS = "id, meeting_id, step, attempts, max_attempts, payload, locked_by, locked_at"
_FAIL_MINE = (
    "UPDATE jobs SET status = 'failed', attempts = :n, last_error = :err, locked_at = NULL, "
    "locked_by = NULL WHERE id = :id AND status = 'running' AND locked_by = :wid RETURNING id"
)
_FAIL_SWEPT = (  # the sweeper holds the row lock (FOR UPDATE)
    "UPDATE jobs SET status = 'failed', attempts = :n, last_error = :err, locked_at = NULL, "
    "locked_by = NULL WHERE id = :id AND status = 'running' RETURNING id"
)
_SWEEP_BATCH = 100


def new_worker_id() -> str:
    return f"worker-{uuid.uuid4().hex[:8]}"


@dataclass
class FailSpec:
    attempts: int
    last_error: str
    meeting_message: str
    metadata: dict[str, Any]


@dataclass
class JobRunner:
    db: Database
    platform: Platform
    steps: Mapping[str, StepHandler]
    transcriber: Transcriber | None = None
    ai: AIService | None = None
    worker_id: str = field(default_factory=new_worker_id)
    step_timeout_s: float = STEP_TIMEOUT_S
    stuck_threshold_s: float = STUCK_THRESHOLD_S
    poll_interval_s: float = POLL_INTERVAL_S
    sweep_interval_s: float = SWEEP_INTERVAL_S
    tmp_root: Path | None = None
    clock: Callable[[], float] = anyio.current_time
    now: Callable[[], datetime] = field(default=lambda: datetime.now(UTC))
    rand: Callable[[], float] = random.random

    # --- claim + dispatch ---------------------------------------------------------------------

    async def claim(self) -> Job | None:
        async with self.db.role_transaction(WORKER) as conn:
            row = (
                (
                    await conn.execute(
                        text(f"SELECT {_JOB_COLUMNS} FROM claim_next_job(:wid)"),  # noqa: S608
                        {"wid": self.worker_id},
                    )
                )
                .mappings()
                .first()
            )
        return Job.from_row(dict(row)) if row else None

    async def run_once(self) -> bool:
        """Claim and run one job. False when no job was ready."""
        job = await self.claim()
        if job is None:
            return False
        log.info(
            "job claimed",
            extra={"job_id": str(job.id), "step": job.step, "attempt": job.attempts,
                   "meeting_id": str(job.meeting_id)},
        )  # fmt: skip
        try:
            outcome = await self._dispatch(job)
        except anyio.get_cancelled_exc_class():
            with anyio.CancelScope(shield=True):
                await self._release(job)
            raise
        except Exception as exc:  # noqa: BLE001 - every step error is recorded on the job
            await self._handle_error(job, exc)
            return True
        await self._record(job, outcome)
        return True

    async def _dispatch(self, job: Job) -> Outcome:
        handler = self.steps.get(job.step)
        if handler is None:
            raise PipelineError(GENERIC_FAILURE, detail=f"Unknown job step: {job.step}")
        if job.step != "start" and deadline_exceeded(job.payload, self.now()):
            return Fail(DEADLINE_EXCEEDED, {"reason": "deadline"})
        workdir = Path(tempfile.mkdtemp(prefix=WORKDIR_PREFIX, dir=self.tmp_root))
        try:
            ctx = StepContext(
                self.db,
                self.platform,
                job,
                workdir,
                self.transcriber,
                self.now,
                self.worker_id,
                self.ai,
            )
            with anyio.fail_after(self.step_timeout_s):
                return await handler(ctx)
        finally:
            with anyio.CancelScope(shield=True):
                await anyio.to_thread.run_sync(shutil.rmtree, workdir, True)

    # --- outcomes -------------------------------------------------------------------------------

    async def _record(self, job: Job, outcome: Outcome) -> None:
        mine = {"id": job.id, "wid": self.worker_id}
        async with self.db.role_transaction(WORKER) as conn:
            if isinstance(outcome, Advance):
                done = await conn.execute(
                    text(
                        "UPDATE jobs SET step = :step, status = 'queued', "
                        "run_after = now() + make_interval(secs => :delay), "
                        "payload = payload || CAST(:patch AS jsonb), locked_at = NULL, "
                        "locked_by = NULL "
                        "WHERE id = :id AND status = 'running' AND locked_by = :wid RETURNING id"
                    ),
                    {**mine, "step": outcome.step, "delay": outcome.delay_s,
                     "patch": json.dumps(outcome.payload)},
                )  # fmt: skip
                if done.first() is None:
                    self._lost(job)
            elif isinstance(outcome, Done):
                done = await conn.execute(
                    text(
                        "UPDATE jobs SET status = 'done', "
                        "payload = payload || CAST(:patch AS jsonb), "
                        "locked_at = NULL, locked_by = NULL "
                        "WHERE id = :id AND status = 'running' AND locked_by = :wid RETURNING id"
                    ),
                    {**mine, "patch": json.dumps(outcome.payload)},
                )
                if done.first() is None:
                    self._lost(job)
                elif outcome.activity is not None:
                    await _activity(conn, job.meeting_id, *outcome.activity)
            else:
                spec = FailSpec(job.attempts, outcome.message, outcome.message, outcome.metadata)
                await self._fail(conn, job, spec, mine=True)
        log.info(
            "job step finished", extra={"job_id": str(job.id), "outcome": type(outcome).__name__}
        )

    def _lost(self, job: Job) -> None:
        log.warning("job lock lost (taken back by the sweeper)", extra={"job_id": str(job.id)})

    async def _handle_error(self, job: Job, exc: Exception) -> None:
        message = error_text(exc)
        terminal = is_terminal(exc)
        retry, attempts = retry_decision(job.attempts, job.max_attempts, terminal=terminal)
        extra = {"job_id": str(job.id), "step": job.step, "meeting_id": str(job.meeting_id),
                 "attempt": attempts, "error_type": type(exc).__name__}  # fmt: skip
        mine = {"id": job.id, "wid": self.worker_id}
        if retry:
            delay = jittered_backoff(attempts, self.rand)
            log.warning("job transient error, retrying in %.0f s", delay, extra=extra)
            async with self.db.role_transaction(WORKER) as conn:
                await conn.execute(
                    text(
                        "UPDATE jobs SET status = 'queued', attempts = :n, last_error = :err, "
                        "run_after = now() + make_interval(secs => :delay), locked_at = NULL, "
                        "locked_by = NULL "
                        "WHERE id = :id AND status = 'running' AND locked_by = :wid"
                    ),
                    {**mine, "n": attempts, "err": message, "delay": delay},
                )
            return
        log.error("job failed (%s)", "terminal" if terminal else "attempts exhausted", extra=extra)
        if not terminal:
            capture_unhandled(exc)
        shown = user_message(exc)
        spec = FailSpec(attempts, message, shown, {"error": activity_error(shown)})
        async with self.db.role_transaction(WORKER) as conn:
            await self._fail(conn, job, spec, mine=True)

    async def _release(self, job: Job) -> None:
        """Shutdown while a step runs: queue the job again at once, attempts unchanged."""
        try:
            async with self.db.role_transaction(WORKER) as conn:
                await conn.execute(
                    text(
                        "UPDATE jobs SET status = 'queued', run_after = now(), locked_at = NULL, "
                        "locked_by = NULL "
                        "WHERE id = :id AND status = 'running' AND locked_by = :wid"
                    ),
                    {"id": job.id, "wid": self.worker_id},
                )
            log.info("job released on shutdown", extra={"job_id": str(job.id)})
        except Exception as exc:  # noqa: BLE001 - the sweeper takes it back after 15 min
            log.warning("job release failed (%s)", type(exc).__name__)

    async def _fail(self, conn: AsyncConnection, job: Job, spec: FailSpec, *, mine: bool) -> None:
        """Job failed → refund (if this job reserved and did not settle) → meeting failed (never a
        done meeting) → activity."""
        row = (
            await conn.execute(
                text(_FAIL_MINE if mine else _FAIL_SWEPT),
                {"id": job.id, "wid": self.worker_id, "n": spec.attempts, "err": spec.last_error},
            )
        ).first()
        if row is None:
            self._lost(job)
            return
        try:  # amount and user come from the job's reserve ledger row (no-op without one)
            async with conn.begin_nested():
                await conn.execute(text("SELECT * FROM pipeline_refund(:job)"), {"job": job.id})
        except SQLAlchemyError as exc:  # never blocks failing the job (v1: non-fatal)
            log.error("quota refund failed (%s)", type(exc).__name__,
                      extra={"job_id": str(job.id)})  # fmt: skip
        await conn.execute(
            text(
                "UPDATE meetings SET status = 'failed', error_message = :msg "
                "WHERE id = :m AND status <> 'done'"
            ),
            {"msg": spec.meeting_message, "m": job.meeting_id},
        )
        await _activity(conn, job.meeting_id, "processing_failed", spec.metadata)

    # --- stuck sweep ----------------------------------------------------------------------------

    async def sweep_stuck(self) -> int:
        """Take back jobs left running by a dead worker. Returns how many were handled."""
        async with self.db.role_transaction(WORKER) as conn:
            rows = (
                (
                    await conn.execute(
                        text(
                            f"SELECT {_JOB_COLUMNS} FROM jobs WHERE status = 'running' "  # noqa: S608
                            "AND locked_at < now() - make_interval(secs => :t) "
                            "ORDER BY locked_at LIMIT :n FOR UPDATE SKIP LOCKED"
                        ),
                        {"t": self.stuck_threshold_s, "n": _SWEEP_BATCH},
                    )
                )
                .mappings()
                .all()
            )
            for row in rows:
                await self._sweep_one(conn, Job.from_row(dict(row)))
        return len(rows)

    async def _sweep_one(self, conn: AsyncConnection, job: Job) -> None:
        retry, attempts = retry_decision(job.attempts, job.max_attempts, terminal=False)
        guard = {"id": job.id}
        log.warning(
            "stuck job found",
            extra={"job_id": str(job.id), "step": job.step, "locked_by": job.locked_by,
                   "attempt": attempts, "requeue": retry},
        )  # fmt: skip
        if not retry:
            spec = FailSpec(
                attempts, JOB_STUCK_FAILED, MEETING_TIMED_OUT, {"reason": "stuck_timeout"}
            )
            await self._fail(conn, job, spec, mine=False)
            return
        if job.step == "start":  # the next run re-claims the meeting (pending/failed guard)
            await conn.execute(
                text(
                    "UPDATE meetings SET status = 'pending' WHERE id = :m AND status = 'processing'"
                ),
                {"m": job.meeting_id},
            )
        await conn.execute(
            text(
                "UPDATE jobs SET status = 'queued', attempts = :n, last_error = :err, "
                "run_after = now(), locked_at = NULL, locked_by = NULL "
                "WHERE id = :id AND status = 'running'"
            ),
            {**guard, "n": attempts, "err": stuck_requeued_message(attempts, job.max_attempts)},
        )

    # --- loop -----------------------------------------------------------------------------------

    def remove_stale_workdirs(self) -> list[str]:
        """Temp dirs of jobs a killed worker left behind (older than 1 h). Never raises."""
        root = Path(self.tmp_root or tempfile.gettempdir())
        try:
            entries = [(p.name, p.stat().st_mtime) for p in root.iterdir() if p.is_dir()]
        except OSError:
            return []
        stale = stale_workdirs(entries, time.time())
        for name in stale:
            shutil.rmtree(root / name, ignore_errors=True)
        if stale:
            log.info("removed %d stale job temp dirs", len(stale))
        return stale

    async def run_forever(self, stop: anyio.Event) -> None:
        log.info("worker started", extra={"worker_id": self.worker_id})
        await anyio.to_thread.run_sync(self.remove_stale_workdirs)
        throttle = ReportThrottle()
        errors = 0  # consecutive loop errors (e.g. database down): back off, report once a minute
        next_sweep = self.clock()
        while not stop.is_set():
            if self.clock() >= next_sweep:
                try:
                    await self.sweep_stuck()
                except Exception as exc:  # noqa: BLE001 - the loop keeps going
                    log.error("stuck sweep failed (%s)", type(exc).__name__)
                next_sweep = self.clock() + self.sweep_interval_s
            try:
                worked = await self.run_once()
                errors = 0
            except Exception as exc:  # noqa: BLE001 - e.g. database unreachable during claim
                errors += 1
                log.error("worker loop error (%s), %d in a row", type(exc).__name__, errors)
                if throttle.allow(self.clock()):
                    capture_unhandled(exc)
                with anyio.move_on_after(loop_error_backoff(errors)):
                    await stop.wait()
                continue
            if not worked:
                with anyio.move_on_after(self.poll_interval_s):
                    await stop.wait()
        log.info("worker stopped", extra={"worker_id": self.worker_id})


async def _activity(
    conn: AsyncConnection, meeting_id: uuid.UUID, event: str, metadata: dict[str, Any]
) -> None:
    """Best effort (v1 fire-and-forget): a failed insert never undoes the job update."""
    try:
        async with conn.begin_nested():
            await conn.execute(
                text(
                    "INSERT INTO activity_log (user_id, event_type, meeting_id, metadata) "
                    "SELECT m.user_id, :e, m.id, CAST(:md AS jsonb) FROM meetings m WHERE m.id = :m"
                ),
                {"e": event, "m": meeting_id, "md": json.dumps(metadata)},
            )
    except SQLAlchemyError as exc:
        log.warning("activity insert failed (%s)", type(exc).__name__)
