"""Daily audio retention purge (ARC-08e; port of v1 ``lib/retention/{policy,purge-runner}.ts``,
§9m). Off unless ``app_config['storage.audio_retention_days']`` is a whole number 1–3650 (fails
closed). Oldest first, at most 500 per run, only ``done`` meetings created strictly before
now − N days that still have audio, only their own key (``owned_audio_path``) and only Google
Drive files (v1 ``r2``/``supabase`` meetings wait for the ARC-18 copy). Per meeting: delete the
file (its own committed step), then compare-and-set ``audio_path = NULL, audio_purged_at = now()``
(still ``done`` with the same key) and the audit row through ``retention_purge_audit`` (forced
``system:retention`` actor), in one transaction. A failed delete leaves the row for the next run.
Transcripts, notes, to-dos and chats are never touched.
"""

from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import text

from app.core.logging import get_logger
from app.db.session import Database
from app.services.platform import Platform
from app.services.storage.ownership import owned_audio_path

log = get_logger("worker.retention")

WORKER = "ricotdin_worker"
# Never purge a meeting a job is working on (a reprocess / requeue needs the audio).
_NO_ACTIVE_JOB = (
    "AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.meeting_id = m.id "
    "AND j.status IN ('queued', 'running')) "
)
RETENTION_SETTING_KEY = "storage.audio_retention_days"
PURGE_BATCH_LIMIT = 500
MAX_RETENTION_DAYS = 3650


def parse_retention_days(value: Any) -> int | None:
    """Whole days 1–3650 (int or digit string), else None = keep forever (v1 fails closed)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        raw = value.strip()
        if not raw.isdigit() or not raw.isascii():
            return None
        n = int(raw)
    elif isinstance(value, int):
        n = value
    else:
        return None
    return n if 1 <= n <= MAX_RETENTION_DAYS else None


def retention_cutoff(now: datetime, days: int) -> datetime:
    return now - timedelta(days=days)


def is_purge_eligible(status: str, audio_path: str | None, created_at: datetime,
                      cutoff: datetime) -> bool:  # fmt: skip
    return status == "done" and bool(audio_path) and created_at < cutoff


async def run_retention_purge(db: Database, platform: Platform, now: datetime) -> Mapping[str, int]:
    counts = {"purged": 0, "failed": 0, "skipped": 0}
    async with db.role_transaction(WORKER) as conn:
        days = parse_retention_days(await platform.config.value(conn, RETENTION_SETTING_KEY))
        if days is None:
            return counts  # purging is off
        cutoff = retention_cutoff(now, days)
        rows = (
            (
                await conn.execute(
                    text(
                        "SELECT m.id, m.user_id, m.status, m.audio_path, m.storage_provider, "  # noqa: S608 - constant SQL fragments only
                        "m.created_at FROM meetings m WHERE m.status = 'done' "
                        "AND m.audio_path IS NOT NULL AND m.storage_provider = 'gdrive' "
                        "AND m.audio_path LIKE m.user_id::text || '/' || m.id::text || '%' "
                        "AND m.created_at < :cutoff "
                        + _NO_ACTIVE_JOB
                        + "ORDER BY m.created_at LIMIT :n"
                    ),
                    {"cutoff": cutoff, "n": PURGE_BATCH_LIMIT},
                )
            )
            .mappings()
            .all()
        )
    for row in rows:
        meeting = dict(row)
        key = owned_audio_path(meeting)
        if key is None or meeting["storage_provider"] != "gdrive":
            # forged path (BUG-003) or a v1 file not copied to Drive yet (ARC-18)
            counts["skipped"] += 1
            continue
        if not is_purge_eligible(meeting["status"], key, meeting["created_at"], cutoff):
            counts["skipped"] += 1
            continue
        try:
            async with db.role_transaction(WORKER) as conn:
                # Re-read right before the delete (v1): still done, same key, no job started since.
                still = await conn.execute(
                    text(
                        "SELECT m.id FROM meetings m WHERE m.id = :id AND m.status = 'done' "  # noqa: S608 - constant SQL fragments only
                        "AND m.audio_path = :key " + _NO_ACTIVE_JOB + "FOR UPDATE OF m"
                    ),
                    {"id": meeting["id"], "key": key},
                )
                if still.first() is None:
                    counts["skipped"] += 1
                    continue
                storage = await platform.storage(conn)
                await storage.delete(key)
        except Exception as exc:  # noqa: BLE001 - row untouched, retried by the next run (v1)
            log.warning("retention delete failed (%s)", type(exc).__name__)
            counts["failed"] += 1
            continue
        async with db.role_transaction(WORKER) as conn:
            done = await conn.execute(
                text(
                    "UPDATE meetings m SET audio_path = NULL, audio_purged_at = now() "  # noqa: S608 - constant SQL fragments only
                    "WHERE m.id = :id AND m.status = 'done' AND m.audio_path = :key "
                    + _NO_ACTIVE_JOB
                    + "RETURNING m.id"
                ),
                {"id": meeting["id"], "key": key},
            )
            if done.first() is None:  # changed in between (reprocessed, deleted): no audit row
                counts["skipped"] += 1
                continue
            await conn.execute(
                text("SELECT retention_purge_audit(:id, :key, :days)"),
                {"id": meeting["id"], "key": key, "days": days},
            )
        counts["purged"] += 1
    log.info("retention purge done", extra=counts)
    return counts
