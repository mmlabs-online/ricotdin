"""Job step ``embed`` — the last step (ARC-08d; port of v1 ``lib/jobs/steps/embed.ts``).

Chunk the transcript (``chunk.py``), embed the chunks (``AIService.embed``, 768 dimensions, no DB
connection held), then in ONE transaction guarded by this worker's lock: replace the meeting's
``transcript_chunks`` (a re-run never duplicates them, v1 REL-03) and mark the meeting ``done``.
The runner then closes the job and logs ``processing_done``. A meeting that is no longer
``processing`` (done by an earlier run, deleted, reprocessed) ends the job without work.
"""

from sqlalchemy import text

from app.core.logging import get_logger
from app.services.ai.service import AIUnavailable, UsageContext
from app.worker.chunk import ChunkSegment, chunk_segments
from app.worker.errors import JobLockLost, PipelineError
from app.worker.jobs import Advance, Done, Outcome, StepContext
from app.worker.messages import GENERIC_FAILURE

log = get_logger("worker.embed")

WORKER = "ricotdin_worker"
RATE_LIMIT_WAIT_MAX_S = 15 * 60


def vector_literal(values: list[float]) -> str:
    """pgvector text form ``[0.1,0.2,…]`` (values are finite floats: ``valid_vectors``)."""
    return "[" + ",".join(repr(v) for v in values) + "]"


async def run_embed(ctx: StepContext) -> Outcome:
    job = ctx.job
    if ctx.ai is None:
        raise PipelineError(GENERIC_FAILURE, detail="no AI service is configured")
    async with ctx.db.role_transaction(WORKER) as conn:
        meeting = (
            await conn.execute(
                text("SELECT user_id, status FROM meetings WHERE id = :m"), {"m": job.meeting_id}
            )
        ).first()
        if meeting is None or meeting.status != "processing":
            log.info("meeting no longer processing: job done", extra={"job_id": str(job.id)})
            return Done()
        rows = (
            await conn.execute(
                text(
                    "SELECT speaker, start_ms, end_ms, text FROM transcript_segments "
                    "WHERE meeting_id = :m ORDER BY segment_index"
                ),
                {"m": job.meeting_id},
            )
        ).all()
    if not rows:
        raise PipelineError(GENERIC_FAILURE, detail="embed: the meeting has no transcript")
    chunks = chunk_segments([ChunkSegment(r.speaker, r.start_ms, r.end_ms, r.text) for r in rows])
    try:
        vectors = await ctx.ai.embed(
            ctx.db, WORKER, [c.content for c in chunks], operation="embed",
            usage=UsageContext(job.meeting_id, meeting.user_id),
        )  # fmt: skip
    except AIUnavailable as exc:
        if exc.retry_after is None:
            raise
        log.info("embedding keys cooling down; embed again in %.0f s", exc.retry_after)
        return Advance("embed", delay_s=min(exc.retry_after, RATE_LIMIT_WAIT_MAX_S) + 1.0)
    m = {"m": job.meeting_id}
    async with ctx.db.role_transaction(WORKER) as conn:
        mine = await conn.execute(
            text(
                "UPDATE jobs SET payload = payload || '{\"embed_done\": true}'::jsonb "
                "WHERE id = :id AND status = 'running' AND locked_by = :wid RETURNING id"
            ),
            {"id": job.id, "wid": ctx.worker_id},
        )
        if mine.first() is None:
            raise JobLockLost("job was taken back while storing the embeddings")
        await conn.execute(text("DELETE FROM transcript_chunks WHERE meeting_id = :m"), m)
        await conn.execute(
            text(
                "INSERT INTO transcript_chunks (meeting_id, chunk_index, content, embedding, "
                "start_ms, end_ms, token_count) VALUES (:m, :i, :c, CAST(:e AS vector), :s, :t, :n)"
            ),
            [{**m, "i": c.chunk_index, "c": c.content, "e": vector_literal(v),
              "s": c.start_ms, "t": c.end_ms, "n": c.token_count}
             for c, v in zip(chunks, vectors, strict=True)],
        )  # fmt: skip
        done = await conn.execute(
            text(
                "UPDATE meetings SET status = 'done', error_message = NULL "
                "WHERE id = :m AND status = 'processing' RETURNING id"
            ),
            m,
        )
        if done.first() is None:  # changed under us: keep nothing of this run
            raise PipelineError(GENERIC_FAILURE, detail="embed: meeting left 'processing'")
    log.info("meeting done", extra={"meeting_id": str(job.meeting_id), "chunks": len(chunks)})
    return Done({"embed_done": True}, ("processing_done", {"chunks": len(chunks)}))
