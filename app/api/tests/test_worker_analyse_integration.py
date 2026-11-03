# ruff: noqa: F811 - pytest fixtures imported from the runner tests are parameters here
"""ARC-08c: the model lock (worker grants: app_settings, profiles defaults, meetings.generation_*)
and step ``analyse`` against a scratch database through the worker login, with a real
``AIService`` over ``httpx2.MockTransport`` (usage rows written as ``ricotdin_worker``)."""

import json
import shutil
import uuid
from collections.abc import Callable
from typing import Any

import anyio
import httpx2
import pytest

from app.core.settings import Settings
from app.db.session import Database
from app.services.ai.model_lock import lock_model
from app.services.ai.service import AIService
from app.services.keys.pool import KeyWithMeta
from app.services.keys.source import KeySource
from app.worker.runner import JobRunner
from app.worker.steps import default_steps
from tests.conftest import requires_db
from tests.test_worker_runner_integration import (  # noqa: F401 - fixtures
    MASTER,
    Case,
    _balance,
    _job,
    _job_row,
    _meeting,
    _no_ready_jobs,
    _reserved,
    _run,
    _seed,
    _sql,
    world,
)

# The shared `world` fixture makes its audio with ffmpeg (CI installs it).
pytestmark = [
    requires_db,
    pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed"),
]

ANSWER = {
    "summary": "Roadmap sync.",
    "notes_markdown": "## Key points\n- ship 08c",
    "todos": [
        {"content": "Write tests", "assignee": "Alice", "due_date": "2026-11-10",
         "source_segment_index": 1},
        {"content": "Bad date", "assignee": None, "due_date": "soon", "source_segment_index": 42},
    ],
    "calendar_suggestions": [
        {"title": "Demo", "proposed_at": "2026-11-12T09:00:00+07:00", "raw_mention": "Thursday 9",
         "source_segment_index": 0},
    ],
}  # fmt: skip


def gemini(body: Any, status: int = 200) -> httpx2.Response:
    if status != 200:
        return httpx2.Response(status, json=body)
    return httpx2.Response(200, json={
        "candidates": [{"content": {"parts": [{"text": body if isinstance(body, str)
                                                else json.dumps(body)}]}}],
        "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 50,
                          "totalTokenCount": 150},
    })  # fmt: skip


class FakeKeysAI(AIService):
    async def _load_keys(self, db: Any, group: str, provider: str) -> list[KeyWithMeta]:
        return [KeyWithMeta(None, "test-key")]


def ai_with(handler: Callable[[httpx2.Request], httpx2.Response]) -> tuple[AIService, list[Any]]:
    seen: list[Any] = []

    def handle(request: httpx2.Request) -> httpx2.Response:
        request.read()
        seen.append(json.loads(request.content))
        return handler(request)

    async def no_sleep(_s: float) -> None:
        return None

    svc = FakeKeysAI(KeySource(None, {}), transport=httpx2.MockTransport(handle), sleep=no_sleep)
    return svc, seen


def _analysing(world: dict[str, Any], *, lock: tuple[str, str] | None = ("gemini", "gemini-2.5-flash"),
               segments: int = 2, **payload: Any) -> Case:  # fmt: skip
    case = _seed(world, status="processing")
    if lock:
        _sql(world["db"], "UPDATE meetings SET generation_provider = %s, generation_model = %s, "
             "started_at = '2026-11-02T08:00:00Z' WHERE id = %s", *lock, case.meeting)  # fmt: skip
    for i in range(segments):
        _sql(world["db"],
             "INSERT INTO transcript_segments (meeting_id, segment_index, speaker, start_ms, "
             "end_ms, text) VALUES (%s, %s, %s, %s, %s, %s)",
             case.meeting, i, f"Speaker {i + 1}", i * 1000, i * 1000 + 900, f"line {i}")  # fmt: skip
    job = _job(world, case, step="analyse",
               payload={"user_id": str(case.user), "started_at": "2999-01-01T00:00:00+00:00",
                        "transcription_settled": True, **payload})  # fmt: skip
    _reserved(world, case, job, 60)
    return case


def _once(world: dict[str, Any], ai: AIService | None) -> bool:
    async def body(runner: Callable[..., JobRunner]) -> bool:
        return await runner(ai=ai).run_once()

    result: bool = _run(world, body)
    return result


def _rows(world: dict[str, Any], sql: str, case: Case) -> list[tuple[Any, ...]]:
    return _sql(world["db"], sql, case.meeting)


# --- model lock -----------------------------------------------------------------------------------


def _lock(world: dict[str, Any], case: Case, payload: dict[str, Any]) -> tuple[str, str]:
    settings = Settings.model_validate(
        {"DATABASE_URL_WORKER": world["worker"], "KEY_ENCRYPTION_SECRET": MASTER.hex()}
    )
    settings.db_pool_worker = (1, 0)

    async def go() -> tuple[str, str]:
        db = await Database.start(settings)
        try:
            async with db.role_transaction("ricotdin_worker") as conn:
                row = _sql(world["db"], "SELECT generation_provider, generation_model FROM "
                           "meetings WHERE id = %s", case.meeting)[0]  # fmt: skip
                meeting = {"id": case.meeting, "user_id": case.user,
                           "generation_provider": row[0], "generation_model": row[1]}  # fmt: skip
                return await lock_model(conn, meeting, payload)
        finally:
            await db.close()

    result: tuple[str, str] = anyio.run(go)
    return result


@pytest.mark.parametrize(
    ("payload", "profile", "expected"),
    [
        ({"preferred_provider": "openai", "preferred_model": "gpt-4o"}, None, ("openai", "gpt-4o")),
        # grok is registered but not on the seeded allow-list: unchecked at /uploaded, refused here
        ({"preferred_provider": "grok", "preferred_model": "grok-4"}, ("openai", "gpt-4o-mini"),
         ("openai", "gpt-4o-mini")),
        ({}, None, ("gemini", "gemini-2.5-flash")),
    ],
)  # fmt: skip
def test_model_lock_is_written_once(
    world: dict[str, Any], payload: dict[str, Any], profile: Any, expected: tuple[str, str]
) -> None:
    case = _seed(world)
    if profile:
        _sql(world["db"], "UPDATE profiles SET default_provider = %s, default_model = %s "
             "WHERE id = %s", *profile, case.user)  # fmt: skip
    assert _lock(world, case, payload) == expected
    stored = _rows(world, "SELECT generation_provider, generation_model FROM meetings "
                   "WHERE id = %s", case)  # fmt: skip
    assert stored == [expected]
    # Locked: a later run with another preference keeps it.
    assert _lock(
        world, case, {"preferred_provider": "openai", "preferred_model": "gpt-4o-mini"}
    ) == (expected)


# --- analyse ------------------------------------------------------------------------------------


def test_analyse_stores_results_and_advances_to_embed(world: dict[str, Any]) -> None:
    case = _analysing(world)
    ai, seen = ai_with(lambda r: gemini(ANSWER))
    assert _once(world, ai)
    assert _job_row(world, case.job)["last_error"] is None  # type: ignore[arg-type]
    assert _rows(world, "SELECT summary, notes FROM meetings WHERE id = %s", case) == [
        ("Roadmap sync.", "## Key points\n- ship 08c")
    ]
    todos = _rows(world, "SELECT t.content, t.assignee, t.due_date::text, s.segment_index "
                  "FROM todos t LEFT JOIN transcript_segments s ON s.id = t.source_segment_id "
                  "WHERE t.meeting_id = %s ORDER BY t.content DESC", case)  # fmt: skip
    assert todos == [("Write tests", "Alice", "2026-11-10", 1), ("Bad date", None, None, None)]
    cal = _rows(world, "SELECT title, proposed_at AT TIME ZONE 'UTC', raw_mention FROM "
                "calendar_suggestions WHERE meeting_id = %s", case)  # fmt: skip
    assert [(c[0], c[1].isoformat(), c[2]) for c in cal] == [
        ("Demo", "2026-11-12T02:00:00", "Thursday 9")
    ]
    row = _job_row(world, case.job)  # type: ignore[arg-type]
    assert (row["step"], row["status"], row["payload"]["analysis_done"]) == (
        "embed",
        "queued",
        True,
    )
    assert _meeting(world, case)[0] == "processing"  # done after embed (08d)
    prompt = seen[0]["contents"][0]["parts"][0]["text"]
    assert prompt.startswith("MEETING_DATE: 2026-11-02T08:00:00+00:00")
    assert "[1] Speaker 2 (1.0s): line 1" in prompt
    assert seen[0]["systemInstruction"]["parts"][0]["text"].startswith("# Meeting Analysis")
    usage = _rows(world, "SELECT provider, operation, unit, quantity::int, status, user_id "
                  "FROM usage_log WHERE meeting_id = %s", case)  # fmt: skip
    assert usage == [("gemini", "analyze", "tokens", 150, "ok", case.user)]


def test_a_rerun_replaces_todos_and_a_finished_one_skips_the_ai(world: dict[str, Any]) -> None:
    case = _analysing(world)
    ai, seen = ai_with(lambda r: gemini(ANSWER))
    assert _once(world, ai)
    _sql(world["db"], "UPDATE jobs SET step = 'analyse', payload = payload || "
         "'{\"analysis_done\": false}' WHERE id = %s", case.job)  # fmt: skip
    assert _once(world, ai)
    assert _rows(world, "SELECT count(*) FROM todos WHERE meeting_id = %s", case) == [(2,)]
    assert len(seen) == 2
    _sql(world["db"], "UPDATE jobs SET step = 'analyse' WHERE id = %s", case.job)
    assert _once(world, ai)
    assert len(seen) == 2  # analysis_done: straight to embed
    assert _job_row(world, case.job)["step"] == "embed"  # type: ignore[arg-type]


def test_an_unusable_answer_twice_fails_with_a_refund(world: dict[str, Any]) -> None:
    case = _analysing(world)
    before = _balance(world, case)
    ai, seen = ai_with(lambda r: gemini("not json at all"))
    assert _once(world, ai)
    assert len(seen) == 2  # strict retry once
    assert seen[1]["contents"][0]["parts"][0]["text"].endswith(
        "No markdown fences, no explanation."
    )
    assert _meeting(world, case) == (
        "failed", "The AI service returned an unusable answer. Please try again.",
    )  # fmt: skip
    assert _balance(world, case) == before + 60
    assert _rows(world, "SELECT count(*) FROM usage_log WHERE meeting_id = %s", case) == [(2,)]


def test_ai_unavailable_is_retried_later(world: dict[str, Any]) -> None:
    case = _analysing(world)
    ai, _ = ai_with(lambda r: gemini({"error": {"status": "UNAVAILABLE"}}, 503))
    assert _once(world, ai)
    row = _job_row(world, case.job)  # type: ignore[arg-type]
    assert (row["step"], row["status"], row["attempts"]) == ("analyse", "queued", 1)
    statuses = _rows(world, "SELECT DISTINCT status, http_code FROM usage_log "
                     "WHERE meeting_id = %s", case)  # fmt: skip
    assert statuses == [("error", 503)]


def test_a_job_from_before_the_lock_locks_the_model_now(world: dict[str, Any]) -> None:
    case = _analysing(world, lock=None, preferred_provider="openai", preferred_model="gpt-4o")

    def handler(request: httpx2.Request) -> httpx2.Response:
        assert request.url.host == "api.openai.com"
        return httpx2.Response(
            200, json={"choices": [{"message": {"content": json.dumps(ANSWER)}}]}
        )

    ai, _ = ai_with(handler)
    assert _once(world, ai)
    assert _rows(world, "SELECT generation_provider, generation_model FROM meetings "
                 "WHERE id = %s", case) == [("openai", "gpt-4o")]  # fmt: skip
    assert _job_row(world, case.job)["step"] == "embed"  # type: ignore[arg-type]


def test_a_meeting_that_is_no_longer_processing_ends_the_job(world: dict[str, Any]) -> None:
    case = _analysing(world)
    _sql(world["db"], "UPDATE meetings SET status = 'done' WHERE id = %s", case.meeting)
    ai, seen = ai_with(lambda r: gemini(ANSWER))
    assert _once(world, ai)
    assert seen == [] and _job_row(world, case.job)["status"] == "done"  # type: ignore[arg-type]


def test_registry_has_analyse() -> None:
    assert "analyse" in default_steps()
    assert uuid.UUID(int=0)  # keep uuid import used for type clarity


def test_rate_limited_keys_requeue_analyse_without_an_attempt(world: dict[str, Any]) -> None:
    case = _analysing(world)
    body = {"error": {"status": "RESOURCE_EXHAUSTED",
                      "details": [{"retryDelay": "40s"}]}}  # fmt: skip
    ai, _ = ai_with(lambda r: gemini(body, 429))
    assert _once(world, ai)
    row = _job_row(world, case.job)  # type: ignore[arg-type]
    assert (row["step"], row["status"], row["attempts"], row["later"]) == (
        "analyse", "queued", 0, True,
    )  # fmt: skip
    assert _meeting(world, case)[0] == "processing"
