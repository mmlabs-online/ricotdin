"""Periodic tasks of the worker (ARC-08e; v1 ran them in-process from ``instrumentation.ts`` and
the job loop). Each task has a row in ``scheduler_runs`` (migration 0006); a worker runs a task
only after leasing it with a compare-and-set UPDATE (no lease held, and the last start older than
the interval), so several worker processes never run the same task at once and "due" survives
restarts. A run is bounded by ``TASK_TIMEOUT_S`` (< ``LEASE_S``) and never stops the job loop:
errors are logged by type and recorded in ``last_status``.
"""

from collections.abc import Awaitable, Callable, Mapping
from datetime import UTC, datetime
from typing import Any

import anyio
from sqlalchemy import text

from app.core.logging import get_logger
from app.db.session import Database
from app.services.platform import Platform
from app.worker.tasks.keyhealth import run_key_health
from app.worker.tasks.maintenance import run_stuck_meetings, run_wallet_reconcile
from app.worker.tasks.retention import run_retention_purge

log = get_logger("worker.schedule")

WORKER = "ricotdin_worker"
DAY_S = 24 * 3600
TASKS: dict[str, int] = {
    "key_health": DAY_S,
    "retention_purge": DAY_S,
    "wallet_reconcile": 5 * 60,
    "stuck_meetings": 5 * 60,
}
LEASE_S = 20 * 60
TASK_TIMEOUT_S = 15 * 60
CHECK_INTERVAL_S = 30.0

_LEASE = (
    "UPDATE scheduler_runs SET lease_owner = :w, "
    "lease_until = now() + make_interval(secs => :lease), last_started_at = now() "
    "WHERE task = :t AND (lease_until IS NULL OR lease_until < now()) "
    "AND (last_started_at IS NULL OR last_started_at <= now() - make_interval(secs => :every)) "
    "RETURNING task"
)
_FINISH = (
    "UPDATE scheduler_runs SET lease_owner = NULL, lease_until = NULL, last_finished_at = now(), "
    "last_status = :s, last_detail = :d WHERE task = :t AND lease_owner = :w"
)

Runner = Callable[[], Awaitable[Mapping[str, Any]]]


class Scheduler:
    def __init__(
        self,
        db: Database,
        platform: Platform,
        worker_id: str,
        *,
        runners: Mapping[str, Runner] | None = None,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.db = db
        self.worker_id = worker_id
        self.runners: Mapping[str, Runner] = runners or {
            "key_health": lambda: run_key_health(db, platform),
            "retention_purge": lambda: run_retention_purge(db, platform, now()),
            "wallet_reconcile": lambda: run_wallet_reconcile(db),
            "stuck_meetings": lambda: run_stuck_meetings(db),
        }

    async def _lease(self, task: str) -> bool:
        async with self.db.role_transaction(WORKER) as conn:
            got = await conn.execute(
                text(_LEASE),
                {"w": self.worker_id, "t": task, "lease": LEASE_S, "every": TASKS[task]},
            )
            return got.first() is not None

    async def _finish(self, task: str, status: str, detail: str) -> None:
        async with self.db.role_transaction(WORKER) as conn:
            await conn.execute(
                text(_FINISH),
                {"w": self.worker_id, "t": task, "s": status, "d": detail[:500]},
            )

    async def run_due(self) -> list[str]:
        """Run every task that is due and not leased elsewhere. Returns the tasks run."""
        ran: list[str] = []
        for task in TASKS:
            runner = self.runners.get(task)
            if runner is None:
                continue
            try:
                if not await self._lease(task):
                    continue
            except Exception as exc:  # noqa: BLE001 - database down: next check
                log.warning("scheduler lease failed (%s)", type(exc).__name__)
                return ran
            ran.append(task)
            try:
                with anyio.fail_after(TASK_TIMEOUT_S):
                    result = await runner()
                status, detail = "ok", ", ".join(f"{k}={v}" for k, v in result.items())
            except Exception as exc:  # noqa: BLE001 - one task never stops the others
                log.error("scheduled task %s failed (%s)", task, type(exc).__name__)
                status, detail = "error", type(exc).__name__
            try:
                with anyio.CancelScope(shield=True):
                    await self._finish(task, status, detail)
            except Exception as exc:  # noqa: BLE001 - the lease expires on its own
                log.warning("scheduler finish failed (%s)", type(exc).__name__)
        return ran

    async def run_forever(self, stop: anyio.Event) -> None:
        while not stop.is_set():
            await self.run_due()
            with anyio.move_on_after(CHECK_INTERVAL_S):
                await stop.wait()
