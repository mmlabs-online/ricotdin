"""Job step ``analyse`` (ARC-08c; port of v1 ``lib/jobs/steps/analyse.ts``).

1. Load the transcript and the meeting (a meeting that is no longer ``processing`` ends the job).
2. Use the meeting's locked model (lock it now for a job that started before 08c).
3. One JSON-mode call through ``AIService`` (no DB connection held while it runs), parsed
   defensively; an unusable answer is retried once with the strict prompt, then terminal.
4. In ONE transaction guarded by this worker's lock: ``payload.analysis_done``, summary + notes,
   the meeting's to-dos and calendar suggestions replaced (a re-run never duplicates them, v1
   REL-03). A re-run after that commit goes straight to ``embed`` without a second AI call.
"""

from typing import Any

from sqlalchemy import text

from app.core.logging import get_logger
from app.services.ai.analysis import (
    ANALYSIS_SCHEMA,
    SegmentText,
    build_user_content,
    parse_analysis,
)
from app.services.ai.model_lock import lock_model
from app.services.ai.prompts import load_prompt
from app.services.ai.service import UsageContext
from app.worker.errors import JobLockLost, PipelineError
from app.worker.jobs import Advance, Done, Outcome, StepContext
from app.worker.messages import GENERIC_FAILURE

log = get_logger("worker.analyse")

WORKER = "ricotdin_worker"


async def run_analyse(ctx: StepContext) -> Outcome:
    job = ctx.job
    if job.payload.get("analysis_done") is True:
        return Advance("embed")
    if ctx.ai is None:
        raise PipelineError(GENERIC_FAILURE, detail="no AI service is configured")
    async with ctx.db.role_transaction(WORKER) as conn:
        meeting = (
            (
                await conn.execute(
                    text(
                        "SELECT id, user_id, status, started_at, generation_provider, "
                        "generation_model FROM meetings WHERE id = :m"
                    ),
                    {"m": job.meeting_id},
                )
            )
            .mappings()
            .first()
        )
        if meeting is None or meeting["status"] != "processing":
            log.info("meeting no longer processing: job done", extra={"job_id": str(job.id)})
            return Done()
        rows = (
            await conn.execute(
                text(
                    "SELECT id, segment_index, speaker, start_ms, text FROM transcript_segments "
                    "WHERE meeting_id = :m ORDER BY segment_index"
                ),
                {"m": job.meeting_id},
            )
        ).all()
        if not rows:
            raise PipelineError(GENERIC_FAILURE, detail="analyse: the meeting has no transcript")
        provider, model = await lock_model(conn, dict(meeting), job.payload)
    segments = [SegmentText(r.speaker, r.start_ms, r.text) for r in rows]
    started = meeting["started_at"]
    meeting_date = started.isoformat() if started is not None else None
    analysis = await ctx.ai.generate_json(
        ctx.db, WORKER, provider, model,
        system=load_prompt(),
        user=build_user_content(segments, strict=False, meeting_date=meeting_date),
        retry_user=build_user_content(segments, strict=True, meeting_date=meeting_date),
        schema=ANALYSIS_SCHEMA, schema_name="meeting_analysis", operation="analyze",
        parse=lambda raw: parse_analysis(raw, len(segments)),
        usage=UsageContext(job.meeting_id, meeting["user_id"]),
    )  # fmt: skip
    ids = [r.id for r in rows]  # segment_index order = the prompt's [N]

    def seg(index: int | None) -> Any:
        return ids[index] if index is not None and 0 <= index < len(ids) else None

    m = {"m": job.meeting_id}
    async with ctx.db.role_transaction(WORKER) as conn:
        mine = await conn.execute(
            text(
                "UPDATE jobs SET payload = payload || '{\"analysis_done\": true}'::jsonb "
                "WHERE id = :id AND status = 'running' AND locked_by = :wid RETURNING id"
            ),
            {"id": job.id, "wid": ctx.worker_id},
        )
        if mine.first() is None:
            raise JobLockLost("job was taken back while storing the analysis")
        await conn.execute(
            text("UPDATE meetings SET summary = :s, notes = :n WHERE id = :m"),
            {**m, "s": analysis.summary, "n": analysis.notes},
        )
        await conn.execute(text("DELETE FROM todos WHERE meeting_id = :m"), m)
        await conn.execute(text("DELETE FROM calendar_suggestions WHERE meeting_id = :m"), m)
        if analysis.todos:
            await conn.execute(
                text(
                    "INSERT INTO todos (meeting_id, content, assignee, due_date, status, "
                    "source_segment_id) VALUES (:m, :c, :a, :d, 'open', :s)"
                ),
                [{**m, "c": t.content, "a": t.assignee, "d": t.due_date,
                  "s": seg(t.segment_index)} for t in analysis.todos],
            )  # fmt: skip
        if analysis.calendar:
            await conn.execute(
                text(
                    "INSERT INTO calendar_suggestions (meeting_id, title, proposed_at, "
                    "raw_mention, dismissed, source_segment_id) VALUES (:m, :t, :p, :r, false, :s)"
                ),
                [{**m, "t": c.title, "p": c.proposed_at, "r": c.raw_mention,
                  "s": seg(c.segment_index)} for c in analysis.calendar],
            )  # fmt: skip
    log.info(
        "analysis stored",
        extra={"meeting_id": str(job.meeting_id), "todos": len(analysis.todos),
               "calendar": len(analysis.calendar), "model": f"{provider}:{model}"},
    )  # fmt: skip
    return Advance("embed", {"analysis_done": True})
