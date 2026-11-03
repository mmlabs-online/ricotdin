# ruff: noqa: F811 - pytest fixtures imported from the runner tests are parameters here
"""ARC-08d: step ``embed`` and the whole pipeline (start → transcribe_poll → analyse → embed)
against a scratch database through the worker login, with fake transcriber + AI providers."""

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx2

from app.worker.jobs import Submission
from app.worker.runner import JobRunner
from tests.conftest import requires_db
from tests.test_worker_analyse_integration import ANSWER, _analysing, ai_with, gemini
from tests.test_worker_runner_integration import (  # noqa: F401 - fixtures
    Case,
    _activity,
    _balance,
    _job,
    _job_row,
    _meeting,
    _no_ready_jobs,
    _run,
    _seed,
    _sql,
    world,
)
from tests.test_worker_speechmatics import TWO_SPEAKER_TRANSCRIPT

pytestmark = requires_db


def provider(request: httpx2.Request) -> httpx2.Response:
    """Fake Gemini: embeddings for batchEmbedContents, the analysis otherwise."""
    if request.url.path.endswith(":batchEmbedContents"):
        n = len(json.loads(request.content)["requests"])
        return httpx2.Response(200, json={"embeddings": [{"values": [0.25] * 768}] * n})
    return gemini(ANSWER)


def _embedding(world: dict[str, Any]) -> Case:
    case = _analysing(world, segments=3, analysis_done=True)
    _sql(world["db"], "UPDATE jobs SET step = 'embed' WHERE id = %s", case.job)
    return case


def _once(world: dict[str, Any], ai: Any, transcriber: Any = None) -> bool:
    async def body(runner: Callable[..., JobRunner]) -> bool:
        return await runner(transcriber, ai=ai).run_once()

    result: bool = _run(world, body)
    return result


def _chunks(world: dict[str, Any], case: Case) -> list[tuple[Any, ...]]:
    return _sql(
        world["db"],
        "SELECT chunk_index, start_ms, end_ms, vector_dims(embedding), token_count > 0 "
        "FROM transcript_chunks WHERE meeting_id = %s ORDER BY chunk_index",
        case.meeting,
    )


def test_embed_stores_chunks_and_finishes_the_meeting(world: dict[str, Any]) -> None:
    case = _embedding(world)
    _sql(world["db"], "INSERT INTO transcript_chunks (meeting_id, chunk_index, content, embedding) "
         "VALUES (%s, 7, 'stale', array_fill(0, ARRAY[768])::vector)", case.meeting)  # fmt: skip
    ai, seen = ai_with(provider)
    assert _once(world, ai)
    assert _chunks(world, case) == [(0, 0, 2900, 768, True)]  # 3 short segments: one chunk
    content = _sql(world["db"], "SELECT content FROM transcript_chunks WHERE meeting_id = %s",
                   case.meeting)[0][0]  # fmt: skip
    assert content == "[Speaker 1] line 0\n[Speaker 2] line 1\n[Speaker 3] line 2"
    assert _meeting(world, case) == ("done", None)
    row = _job_row(world, case.job)  # type: ignore[arg-type]
    assert row["status"] == "done" and row["payload"]["embed_done"] is True
    assert ("processing_done", {"chunks": 1}) in _activity(world, case)
    usage = _sql(world["db"], "SELECT provider, operation, unit, quantity::int FROM usage_log "
                 "WHERE meeting_id = %s", case.meeting)  # fmt: skip
    assert usage == [("gemini-embedding", "embed", "tokens", 1)]
    assert seen[0]["requests"][0]["outputDimensionality"] == 768


def test_a_meeting_already_done_is_not_embedded_again(world: dict[str, Any]) -> None:
    case = _embedding(world)
    _sql(world["db"], "UPDATE meetings SET status = 'done' WHERE id = %s", case.meeting)
    ai, seen = ai_with(provider)
    assert _once(world, ai)
    assert seen == [] and _job_row(world, case.job)["status"] == "done"  # type: ignore[arg-type]
    assert _chunks(world, case) == []


def test_embedding_failure_fails_the_meeting_with_a_refund(world: dict[str, Any]) -> None:
    case = _embedding(world)
    before = _balance(world, case)
    ai, _ = ai_with(lambda r: httpx2.Response(200, json={"embeddings": []}))
    assert _once(world, ai)
    assert _meeting(world, case) == (
        "failed", "The AI service returned an unusable answer. Please try again.",
    )  # fmt: skip
    assert _balance(world, case) == before + 60  # transcription_settled is in the payload only
    assert _chunks(world, case) == []


class PipelineTranscriber:
    def __init__(self) -> None:
        self.released: list[Submission] = []

    async def submit(self, audio: Path, *, language: str | None,
                     speaker_count: int | None) -> Submission:  # fmt: skip
        return Submission("smjob", "env:abcdef0123456789")

    async def status(self, sub: Submission) -> tuple[str, list[Any]]:
        return "done", []

    async def transcript(self, sub: Submission) -> Any:
        return TWO_SPEAKER_TRANSCRIPT

    def release(self, sub: Submission) -> None:
        self.released.append(sub)


def test_the_whole_pipeline_reaches_done(world: dict[str, Any]) -> None:
    case = _seed(world)
    _job(world, case, step="start")
    ai, seen = ai_with(provider)
    transcriber = PipelineTranscriber()
    steps: list[str] = []
    for _ in range(6):
        row = _job_row(world, case.job)  # type: ignore[arg-type]
        if row["status"] == "done":
            break
        steps.append(row["step"])
        _sql(world["db"], "UPDATE jobs SET run_after = now() WHERE id = %s", case.job)
        assert _once(world, ai, transcriber)
    assert steps == ["start", "transcribe_poll", "analyse", "embed"]
    assert _meeting(world, case) == ("done", None)
    status, summary, provider_, model = _sql(
        world["db"], "SELECT status, summary, generation_provider, generation_model FROM meetings "
        "WHERE id = %s", case.meeting)[0]  # fmt: skip
    assert (summary, provider_, model) == ("Roadmap sync.", "gemini", "gemini-2.5-flash")
    counts = _sql(world["db"], "SELECT (SELECT count(*) FROM transcript_segments WHERE "
                  "meeting_id = %s), (SELECT count(*) FROM todos WHERE meeting_id = %s), "
                  "(SELECT count(*) FROM transcript_chunks WHERE meeting_id = %s)",
                  case.meeting, case.meeting, case.meeting)  # fmt: skip
    assert counts == [(2, 2, 1)]
    events = [e for e, _ in _activity(world, case)]
    assert events == ["processing_done"]
    units = _sql(world["db"], "SELECT DISTINCT provider, unit FROM usage_log WHERE meeting_id = %s "
                 "ORDER BY provider", case.meeting)  # fmt: skip
    assert units == [("gemini", "tokens"), ("gemini-embedding", "tokens"),
                     ("speechmatics", "audio_seconds")]  # fmt: skip
