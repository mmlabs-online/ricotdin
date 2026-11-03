"""Two 5-minute housekeeping tasks (ARC-08e).

* ``run_wallet_reconcile``: ``quota_reconcile_wallets`` (migration 0006, v1 QUO-04): a wallet that
  differs from its ledger sum is set to it, with a zero-delta audit row (BUG-021 fixed by design).
* ``run_stuck_meetings`` (v1 QUO-02 sweep, reduced): the runner's stuck sweep already fails and
  refunds stuck JOBS; this ends MEETINGS left ``processing`` for over 30 min with no queued or
  running job (e.g. migrated from v1 mid-run), with the user-facing timeout message, a v1
  meeting-keyed reserve refunded (``legacy_reserve_refund``) and ``processing_failed`` logged.
"""

import uuid
from collections.abc import Mapping

from sqlalchemy import text

from app.core.logging import get_logger
from app.db.session import Database
from app.worker.messages import MEETING_TIMED_OUT

log = get_logger("worker.maintenance")

WORKER = "ricotdin_worker"
STUCK_MEETING_MINUTES = 30


async def run_wallet_reconcile(db: Database) -> Mapping[str, int]:
    async with db.role_transaction(WORKER) as conn:
        row = (
            await conn.execute(
                text("SELECT checked, drifted FROM quota_reconcile_wallets(:run)"),
                {"run": uuid.uuid4()},
            )
        ).one()
    counts = {"checked": int(row.checked), "drifted": int(row.drifted)}
    if counts["drifted"]:
        log.warning("wallet drift corrected", extra=counts)
    return counts


async def run_stuck_meetings(db: Database) -> Mapping[str, int]:
    async with db.role_transaction(WORKER) as conn:
        rows = (
            await conn.execute(
                text(
                    "UPDATE meetings m SET status = 'failed', error_message = :msg "
                    "WHERE m.status = 'processing' "
                    "AND m.updated_at < now() - make_interval(mins => :mins) "
                    "AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.meeting_id = m.id "
                    "AND j.status IN ('queued', 'running')) RETURNING m.id"
                ),
                {"msg": MEETING_TIMED_OUT, "mins": STUCK_MEETING_MINUTES},
            )
        ).all()
        refunded = 0
        for (meeting_id,) in rows:
            # v1 meetings migrated mid-run hold a meeting-keyed reserve (v1 QUO-02): give it back.
            got = (
                await conn.execute(
                    text("SELECT status FROM legacy_reserve_refund(:m)"), {"m": meeting_id}
                )
            ).first()
            if got is not None and got.status == "applied":
                refunded += 1
            await conn.execute(
                text(
                    "INSERT INTO activity_log (user_id, event_type, meeting_id, metadata) "
                    "SELECT m.user_id, 'processing_failed', m.id, CAST(:md AS jsonb) "
                    "FROM meetings m WHERE m.id = :m"
                ),
                {"m": meeting_id, "md": '{"reason": "stuck_meeting"}'},
            )
    if rows:
        log.warning("stuck meetings failed", extra={"count": len(rows), "refunded": refunded})
    return {"failed": len(rows), "refunded": refunded}
