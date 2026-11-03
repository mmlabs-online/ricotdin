"""Job step ``transcribe_poll`` (ARC-08b; port of v1 ``lib/jobs/steps/transcribePoll.ts``).

Checks the provider job ONCE and returns (no waiting inside the step):

* ``running`` → poll again in 5 s (the job is re-queued; no attempt used).
* ``done`` → fetch + parse the transcript. No speech → terminal ``PipelineError`` (the meeting
  fails, the reserve is refunded; v1's job path marked such a meeting ``done``, the spec says it
  must not be). Otherwise, in ONE transaction guarded by this worker's lock: mark the payload
  ``transcription_settled``, settle quota (``pipeline_settle``: reserved − ceil(actual)),
  replace the meeting's segments (old chunks too), set the language, log usage
  (``audio_seconds``). Then continue at ``analyse``. A re-run after that commit skips straight
  to ``analyse``.
* ``rejected`` for language detection, first time → download, transcode, resubmit with
  ``language='en'`` and poll again (v1).
* other ``rejected`` / ``deleted`` → terminal (provider rejection). ``unknown`` → retried.
"""

import json
import math
import uuid
from typing import Any

from sqlalchemy import text

from app.core.logging import get_logger
from app.services.storage.ownership import owned_audio_path
from app.worker import audio
from app.worker.errors import JobLockLost, PipelineError, TransientError
from app.worker.jobs import Advance, Outcome, StepContext, Submission, Transcriber
from app.worker.messages import GENERIC_FAILURE
from app.worker.speechmatics import (
    billed_seconds,
    has_speech,
    is_language_detect_failure,
    parse_transcript,
    safe_job_id,
)
from app.worker.speechmatics_client import PROVIDER_REJECTED, SpeechmaticsKeyRejected
from app.worker.start import source_suffix, speaker_count_hint

log = get_logger("worker.transcribe_poll")

WORKER = "ricotdin_worker"
POLL_INTERVAL_S = 5.0
MAX_SETTLE_SECONDS = 86400  # pipeline_settle bound
NO_SPEECH = "No speech was detected in this recording."
_INSERT_SEGMENT = (
    "INSERT INTO transcript_segments (meeting_id, segment_index, speaker, start_ms, end_ms, text, "
    "confidence) VALUES (:m, :i, :speaker, :start, :end, :text, :conf)"
)


def _submission(payload: dict[str, Any]) -> Submission:
    job_id = safe_job_id(payload.get("transcriber_job_id"))
    ref = payload.get("transcriber_key_ref")
    if job_id is None or not isinstance(ref, str):
        raise PipelineError(
            GENERIC_FAILURE, detail="transcribe_poll: no transcriber job in payload"
        )
    return Submission(job_id, ref)


def _key_id(ref: str | None) -> uuid.UUID | None:
    if ref and ref.startswith("id:"):
        try:
            return uuid.UUID(ref[3:])
        except ValueError:
            return None
    return None


async def _provider(call: Any) -> Any:
    """A job created with a key that is now rejected cannot be reached: terminal."""
    try:
        return await call
    except SpeechmaticsKeyRejected as exc:
        raise PipelineError(GENERIC_FAILURE, detail=str(exc)) from None


async def run_transcribe_poll(ctx: StepContext) -> Outcome:
    payload = ctx.job.payload
    if payload.get("transcription_settled") is True:
        log.info("transcript already stored: continuing", extra={"job_id": str(ctx.job.id)})
        return Advance("analyse")
    transcriber = ctx.transcriber
    if transcriber is None:
        raise PipelineError(GENERIC_FAILURE, detail="no transcription provider is configured")
    sub = _submission(payload)
    status, errors = await _provider(transcriber.status(sub))
    log.info("transcription status %s", status, extra={"meeting_id": str(ctx.job.meeting_id)})
    if status == "running":
        return Advance("transcribe_poll", delay_s=POLL_INTERVAL_S)
    if status == "done":
        return await _store(ctx, transcriber, sub)
    if status == "unknown":
        raise TransientError("transcribe_poll: unexpected job status response")
    transcriber.release(sub)
    if (
        status == "rejected"
        and is_language_detect_failure(errors)
        and not payload.get("lang_retry")
    ):
        return await _resubmit_english(ctx, transcriber)
    detail = json.dumps(errors, default=str)[:300]
    raise PipelineError(PROVIDER_REJECTED, detail=f"speechmatics job {status}: {detail}")


async def _store(ctx: StepContext, transcriber: Transcriber, sub: Submission) -> Outcome:
    job = ctx.job
    raw = await _provider(transcriber.transcript(sub))
    transcript = parse_transcript(raw)
    seconds = billed_seconds(raw)
    if not has_speech(transcript.segments):
        transcriber.release(sub)
        raise PipelineError(
            NO_SPEECH, detail=f"transcript has no speech ({len(transcript.segments)} segments)"
        )
    actual = min(math.ceil(seconds), MAX_SETTLE_SECONDS)
    async with ctx.db.role_transaction(WORKER) as conn:
        mine = await conn.execute(
            text(
                "UPDATE jobs SET payload = payload || '{\"transcription_settled\": true}'::jsonb "
                "WHERE id = :id AND status = 'running' AND locked_by = :wid RETURNING id"
            ),
            {"id": job.id, "wid": ctx.worker_id},
        )
        if mine.first() is None:
            raise JobLockLost("job was taken back while storing the transcript")
        settle = (
            await conn.execute(
                text("SELECT status, delta FROM pipeline_settle(:job, :s)"),
                {"job": job.id, "s": actual},
            )
        ).one()
        m = {"m": job.meeting_id}
        await conn.execute(text("DELETE FROM transcript_chunks WHERE meeting_id = :m"), m)
        await conn.execute(text("DELETE FROM transcript_segments WHERE meeting_id = :m"), m)
        await conn.execute(
            text(_INSERT_SEGMENT),
            [
                {"m": job.meeting_id, "i": i, "speaker": s.speaker, "start": s.start_ms,
                 "end": s.end_ms, "text": s.text, "conf": s.confidence}
                for i, s in enumerate(transcript.segments)
            ],
        )  # fmt: skip
        await conn.execute(
            text("UPDATE meetings SET language = :lang WHERE id = :m"),
            {**m, "lang": transcript.language},
        )
        await conn.execute(
            text(
                "INSERT INTO usage_log (provider, model, operation, audio_seconds, unit, quantity, "
                "status, meeting_id, user_id, key_id) "
                "SELECT 'speechmatics', 'standard', 'transcribe', :s, 'audio_seconds', :s, 'ok', "
                "id, user_id, (SELECT a.id FROM admin_config a WHERE a.id = :key) "
                "FROM meetings WHERE id = :m"
            ),
            {**m, "s": seconds, "key": _key_id(sub.key_ref)},
        )
    transcriber.release(sub)
    log.info(
        "transcript stored",
        extra={"meeting_id": str(job.meeting_id), "segments": len(transcript.segments),
               "settle": settle.status},
    )  # fmt: skip
    return Advance("analyse", {"transcription_settled": True})


async def _resubmit_english(ctx: StepContext, transcriber: Transcriber) -> Outcome:
    job = ctx.job
    log.info("language detection rejected: resubmitting with en",
             extra={"meeting_id": str(job.meeting_id)})  # fmt: skip
    async with ctx.db.role_transaction(WORKER) as conn:
        row = (
            (
                await conn.execute(
                    text(
                        "SELECT id, user_id, audio_path, storage_provider, source FROM meetings "
                        "WHERE id = :m AND status = 'processing'"
                    ),
                    {"m": job.meeting_id},
                )
            )
            .mappings()
            .first()
        )
    if row is None:
        raise PipelineError(GENERIC_FAILURE, detail="meeting is no longer processing")
    key = owned_audio_path(dict(row))
    if key is None or row["storage_provider"] != "gdrive":  # BUG-003 / ARC-18, as in start
        raise PipelineError(
            "The audio file of this meeting is invalid.",
            detail="audio_path not owned or not in gdrive (language retry)",
        )
    source = ctx.workdir / f"source{source_suffix(key)}"
    await audio.download(ctx.db, ctx.platform, key, source)
    if row["source"] == "video":
        source = await audio.extract_audio(source, ctx.workdir / "extracted.mp3")
    upload = await audio.transcode(source, ctx.workdir)
    sub = await transcriber.submit(
        upload, language="en", speaker_count=speaker_count_hint(job.payload)
    )
    return Advance(
        "transcribe_poll",
        {"transcriber_job_id": sub.job_id, "transcriber_key_ref": sub.key_ref, "lang_retry": True},
        delay_s=POLL_INTERVAL_S,
    )
