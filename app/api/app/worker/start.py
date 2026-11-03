"""Job step ``start`` (ARC-08; port of v1 ``lib/jobs/steps/start.ts``).

1. Claim the meeting atomically (``pending``/``failed`` → ``processing``); a meeting already
   ``processing`` is a restart and continues; anything else (done, deleted) ends the job.
2. Prove the audio key belongs to the meeting (terminal if forged) and is in Google Drive.
3. Model lock hook (ARC-08c).
4. Download, validate streams with ffprobe (``video`` meetings: extract the audio track first;
   owner decision: extraction moved from ``/uploaded`` to the worker), estimate the duration.
5. Reserve quota once per job (``pipeline_reserve``: the meeting owner, ``gen:<job_id>:reserve``)
   and record it in the job payload in the same transaction, guarded by this worker's lock.
   Insufficient balance ends the job (``QUOTA_BLOCKED: …``). A later failure refunds from the
   ledger (``pipeline_refund``), whatever the payload says.
6. Transcode to mono 16 kHz mp3 (failure keeps the original), submit to the transcriber and
   continue at ``transcribe_poll`` after 5 s.
"""

import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.logging import get_logger
from app.services.storage.ownership import owned_audio_path
from app.worker import audio
from app.worker.errors import JobLockLost, PipelineError, TransientError
from app.worker.jobs import Advance, Done, Fail, Outcome, StepContext
from app.worker.messages import GENERIC_FAILURE, quota_blocked_message
from app.worker.policy import FIRST_POLL_DELAY_S, MAX_AUDIO_SECONDS
from app.worker.quota import estimate_seconds

log = get_logger("worker.start")

WORKER = "ricotdin_worker"
_CLAIM = (
    "UPDATE meetings SET status = 'processing', error_message = NULL "
    "WHERE id = :id AND status IN ('pending', 'failed') "
    "RETURNING id, user_id, audio_path, storage_provider, source, duration_seconds, language, "
    "generation_provider, generation_model"
)
_RESTART = (
    "SELECT id, user_id, audio_path, storage_provider, source, duration_seconds, language, "
    "generation_provider, generation_model FROM meetings WHERE id = :id AND status = 'processing'"
)
_SUFFIX_OK = {".mp3", ".m4a", ".wav", ".aac", ".ogg", ".flac", ".webm",
              ".mp4", ".mov", ".avi", ".mkv", ".m4v"}  # fmt: skip


async def _claim_meeting(conn: AsyncConnection, ctx: StepContext) -> dict[str, Any] | None:
    mid = ctx.job.meeting_id
    row = (
        (
            await conn.execute(
                text(_CLAIM),
                {"id": mid},
            )
        )
        .mappings()
        .first()
    )
    if row is None:  # restart: a previous attempt already claimed it
        row = (
            (
                await conn.execute(
                    text(_RESTART),
                    {"id": mid},
                )
            )
            .mappings()
            .first()
        )
        if row is not None:
            log.info("meeting already processing: continuing", extra={"meeting_id": str(mid)})
    return dict(row) if row else None


async def lock_generation_model(
    conn: AsyncConnection, ctx: StepContext, meeting: dict[str, Any]
) -> None:
    """ARC-08c hook (AIP-03/06): write ``generation_provider/model`` once per meeting from
    ``payload.preferred_*`` (only if on the allow-list), the profile default or the system
    default. Intentionally does nothing until 08c lands."""
    return None


def source_suffix(key: str) -> str:
    dot = key.rfind(".")
    suffix = key[dot:].lower() if dot > key.rfind("/") else ""
    return suffix if suffix in _SUFFIX_OK else ".bin"


async def run_start(ctx: StepContext) -> Outcome:
    job = ctx.job
    async with ctx.db.role_transaction(WORKER) as conn:
        meeting = await _claim_meeting(conn, ctx)
        if meeting is None:
            log.info("meeting not claimable (done or deleted): job done",
                     extra={"meeting_id": str(job.meeting_id)})  # fmt: skip
            return Done()
        if not meeting["audio_path"]:
            raise TransientError("Meeting has no audio_path — cannot process")  # v1: retried
        key = owned_audio_path(meeting)
        if key is None:  # BUG-003: never read another user's recording
            raise PipelineError(
                "The audio file of this meeting is invalid.",
                detail="audio_path does not belong to this meeting — refusing to process",
            )
        if meeting["storage_provider"] != "gdrive":
            raise PipelineError(
                "The audio of this meeting has not been moved to the new storage yet. "
                "Please try again later.",
                detail=f"storage_provider '{meeting['storage_provider']}', not gdrive (ARC-18)",
            )
        await lock_generation_model(conn, ctx, meeting)

    source = ctx.workdir / f"source{source_suffix(key)}"
    size = await audio.download(ctx.db, ctx.platform, key, source)
    log.info("audio downloaded", extra={"meeting_id": str(job.meeting_id), "bytes": size})

    if meeting["source"] == "video":
        probed = await audio.inspect(source, "video")
        source = await audio.extract_audio(source, ctx.workdir / "extracted.mp3")
    else:
        probed = await audio.inspect(source, "audio-only")
    estimate = estimate_seconds(probed, meeting["duration_seconds"])
    if estimate > MAX_AUDIO_SECONDS:
        raise PipelineError(
            f"Recordings longer than {MAX_AUDIO_SECONDS // 3600} hours cannot be processed.",
            detail=f"estimate {estimate} s",
        )
    user = meeting["user_id"]

    state: dict[str, Any] = {
        "user_id": str(user),
        "estimate_seconds": estimate,
        "reserve_done": False,
        "transcription_settled": False,
        "started_at": job.payload.get("started_at") or ctx.now().isoformat(),
    }
    async with ctx.db.role_transaction(WORKER) as conn:
        reserved = False
        if estimate > 0:
            # User = the job's meeting owner, key gen:<job>:reserve (SQL wrapper, migration 0005).
            reserve = (
                await conn.execute(
                    text("SELECT status, audio_remaining FROM pipeline_reserve(:job, :d)"),
                    {"job": job.id, "d": estimate},
                )
            ).one()
            if reserve.status == "insufficient":
                remaining = int(reserve.audio_remaining or 0)
                return Fail(
                    quota_blocked_message(estimate, remaining),
                    {"reason": "quota_blocked", "required_seconds": estimate,
                     "remaining_seconds": remaining},
                )  # fmt: skip
            reserved = True  # 'applied' or 'already_applied' (retry of this job)
        # Recorded in the same transaction as the reserve, only while this worker still holds the
        # job: otherwise both roll back. reserve_done never goes from true back to false.
        merged = (
            await conn.execute(
                text(
                    "UPDATE jobs SET payload = payload || CAST(:p AS jsonb) || jsonb_build_object("
                    "'reserve_done', COALESCE((payload->>'reserve_done')::boolean, false) OR :rd) "
                    "WHERE id = :id AND status = 'running' AND locked_by = :wid "
                    "RETURNING (payload->>'reserve_done')::boolean"
                ),
                {"p": json.dumps(state), "rd": reserved, "id": job.id, "wid": ctx.worker_id},
            )
        ).first()
        if merged is None:
            raise JobLockLost("job was taken back while starting; reserve rolled back")
        state["reserve_done"] = bool(merged[0])

    if ctx.transcriber is None:
        raise PipelineError(GENERIC_FAILURE, detail="no transcription provider is configured")
    upload = await audio.transcode(source, ctx.workdir)
    submission = await ctx.transcriber.submit(
        upload,
        language=None,
        speaker_count=speaker_count_hint(job.payload),  # v1: auto-detect
    )
    log.info("transcription submitted", extra={"meeting_id": str(job.meeting_id)})
    return Advance(
        "transcribe_poll",
        {**state, "transcriber_job_id": submission.job_id,
         "transcriber_key_ref": submission.key_ref},
        delay_s=FIRST_POLL_DELAY_S,
    )  # fmt: skip


def speaker_count_hint(payload: dict[str, Any]) -> int | None:
    value = payload.get("speaker_count")
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None
