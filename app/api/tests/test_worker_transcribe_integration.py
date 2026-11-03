# ruff: noqa: F811 - pytest fixtures imported from the runner tests are parameters here
"""ARC-08b: step ``transcribe_poll`` against a scratch database through the worker login: poll
again while running, store segments + settle + usage exactly once, no speech → failed with a
full refund, language-detection retry with ``en``, provider rejection terminal."""

import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import anyio

from app.worker.jobs import Submission
from app.worker.transcribe_poll import NO_SPEECH
from tests.conftest import requires_db
from tests.test_worker_runner_integration import (  # noqa: F401 - fixtures
    Case,
    _balance,
    _job,
    _job_row,
    _ledger,
    _meeting,
    _no_ready_jobs,
    _once,
    _reserved,
    _seed,
    _sql,
    world,
)
from tests.test_worker_speechmatics import TWO_SPEAKER_TRANSCRIPT

pytestmark = requires_db

KEY_ID = "00000000-0000-0000-0000-00000000c0de"


@dataclass
class PollFake:
    statuses: list[tuple[str, list[Any]]] = field(default_factory=lambda: [("done", [])])
    raw: Any = field(default_factory=lambda: TWO_SPEAKER_TRANSCRIPT)
    submitted: list[dict[str, Any]] = field(default_factory=list)
    released: list[Submission] = field(default_factory=list)
    polled: list[Submission] = field(default_factory=list)

    async def submit(
        self, audio: Path, *, language: str | None, speaker_count: int | None
    ) -> Submission:
        self.submitted.append(
            {
                "name": audio.name,
                "language": language,
                "size": (await anyio.Path(audio).stat()).st_size,
            }
        )
        return Submission(f"retry{len(self.submitted)}", "env:abcdef0123456789")

    async def status(self, sub: Submission) -> tuple[str, list[Any]]:
        self.polled.append(sub)
        return self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]

    async def transcript(self, sub: Submission) -> Any:
        return self.raw

    def release(self, sub: Submission) -> None:
        self.released.append(sub)


def _polling(world: dict[str, Any], *, reserve: int = 60, **payload: Any) -> Case:
    case = _seed(world, status="processing")
    job = _job(
        world, case, step="transcribe_poll",
        payload={"transcriber_job_id": "smjob1", "transcriber_key_ref": f"id:{KEY_ID}",
                 "user_id": str(case.user), "estimate_seconds": reserve, "reserve_done": True,
                 "transcription_settled": False, "started_at": "2999-01-01T00:00:00+00:00",
                 **payload},
    )  # fmt: skip
    if reserve:
        _reserved(world, case, job, reserve)
    return case


def _segments(world: dict[str, Any], case: Case) -> list[tuple[Any, ...]]:
    return _sql(
        world["db"],
        "SELECT segment_index, speaker, start_ms, end_ms, text, confidence::float "
        "FROM transcript_segments WHERE meeting_id = %s ORDER BY segment_index",
        case.meeting,
    )


def test_running_polls_again_without_an_attempt(world: dict[str, Any]) -> None:
    case = _polling(world)
    fake = PollFake(statuses=[("running", [])])
    assert _once(world, fake)
    row = _job_row(world, case.job)  # type: ignore[arg-type]
    assert (row["step"], row["status"], row["attempts"], row["later"]) == (
        "transcribe_poll", "queued", 0, True,
    )  # fmt: skip
    assert fake.polled == [Submission("smjob1", f"id:{KEY_ID}")] and fake.released == []


def test_done_stores_segments_settles_and_logs_usage_once(world: dict[str, Any]) -> None:
    case = _polling(world)
    _sql(
        world["db"],
        "INSERT INTO transcript_segments (meeting_id, segment_index, start_ms, end_ms, text) "
        "VALUES (%s, 0, 0, 1, 'old run')",
        case.meeting,
    )
    fake = PollFake()
    before = _balance(world, case)
    assert _once(world, fake)
    assert _job_row(world, case.job)["last_error"] is None  # type: ignore[arg-type]
    assert _segments(world, case) == [
        (0, "Speaker 1", 160, 920, "Hello everyone.", 0.98),
        (1, "Speaker 2", 1200, 2600, "Hi there, thanks", 0.96),
    ]
    assert _sql(world["db"], "SELECT language FROM meetings WHERE id = %s", case.meeting) == [
        ("en",)
    ]
    # reserved 60, used ceil(2.6) = 3: 57 back
    assert _balance(world, case) == before + 57
    assert _ledger(world, case)[-1] == (f"gen:{case.job}:settle", 57)
    usage = _sql(
        world["db"],
        "SELECT provider, operation, unit, quantity::float, audio_seconds::float, user_id, key_id "
        "FROM usage_log WHERE meeting_id = %s",
        case.meeting,
    )
    assert usage == [("speechmatics", "transcribe", "audio_seconds", 2.6, 2.6, case.user, None)]
    row = _job_row(world, case.job)  # type: ignore[arg-type]
    assert (row["step"], row["status"], row["payload"]["transcription_settled"]) == (
        "analyse", "queued", True,
    )  # fmt: skip
    assert fake.released == [Submission("smjob1", f"id:{KEY_ID}")]
    assert _meeting(world, case)[0] == "processing"  # done only after analyse + embed

    # A re-run of the step (e.g. after a crash) never calls the provider or charges again.
    _sql(world["db"], "UPDATE jobs SET step = 'transcribe_poll' WHERE id = %s", case.job)
    again = PollFake()
    assert _once(world, again)
    assert again.polled == [] and len(_ledger(world, case)) == 2
    assert _job_row(world, case.job)["step"] == "analyse"  # type: ignore[arg-type]


def test_usage_keeps_the_admin_key_id(world: dict[str, Any]) -> None:
    _sql(
        world["db"],
        "INSERT INTO admin_config (id, config_key, label, value_ciphertext, value_iv, "
        "value_auth_tag, status, last4) VALUES (%s, 'speechmatics_api_key', 't', 'x', 'x', 'x', "
        "'disabled', '0000') "
        "ON CONFLICT DO NOTHING",
        uuid.UUID(KEY_ID),
    )
    case = _polling(world)
    assert _once(world, PollFake())
    assert _sql(
        world["db"], "SELECT key_id FROM usage_log WHERE meeting_id = %s", case.meeting
    ) == [(uuid.UUID(KEY_ID),)]


def test_no_speech_fails_the_meeting_with_a_full_refund(world: dict[str, Any]) -> None:
    case = _polling(world)
    before = _balance(world, case)
    fake = PollFake(raw={"results": [{"type": "punctuation", "alternatives": [{"content": "."}]}]})
    assert _once(world, fake)
    assert _meeting(world, case) == ("failed", NO_SPEECH)
    assert _job_row(world, case.job)["status"] == "failed"  # type: ignore[arg-type]
    assert _balance(world, case) == before + 60
    assert [k for k, _ in _ledger(world, case)] == [
        f"gen:{case.job}:reserve", f"gen:{case.job}:refund",
    ]  # fmt: skip
    assert _segments(world, case) == [] and len(fake.released) == 1


def test_language_detection_is_retried_once_with_en(world: dict[str, Any]) -> None:
    case = _polling(world)
    lang = [{"message": "Language identification could not identify any language"}]
    fake = PollFake(statuses=[("rejected", lang)])
    assert _once(world, fake)
    assert len(fake.submitted) == 1 and fake.submitted[0]["language"] == "en"
    assert fake.submitted[0]["name"].endswith(".mp3") and fake.submitted[0]["size"] > 0
    row = _job_row(world, case.job)  # type: ignore[arg-type]
    assert (row["step"], row["status"], row["attempts"]) == ("transcribe_poll", "queued", 0)
    assert row["payload"]["transcriber_job_id"] == "retry1"
    assert row["payload"]["transcriber_key_ref"] == "env:abcdef0123456789"
    assert row["payload"]["lang_retry"] is True
    assert fake.released == [Submission("smjob1", f"id:{KEY_ID}")]

    _sql(world["db"], "UPDATE jobs SET run_after = now() WHERE id = %s", case.job)
    assert _once(world, fake)  # a second detection failure is terminal
    assert _meeting(world, case)[0] == "failed"
    assert len(fake.submitted) == 1


def test_a_rejected_or_deleted_job_is_terminal_and_refunds(world: dict[str, Any]) -> None:
    for status in ("rejected", "deleted"):
        case = _polling(world)
        before = _balance(world, case)
        assert _once(world, PollFake(statuses=[(status, [{"message": "Audio too short"}])]))
        message = _meeting(world, case)
        assert message == ("failed", "The transcription service could not process this recording.")
        row = _job_row(world, case.job)  # type: ignore[arg-type]
        assert row["status"] == "failed" and "Audio too short" in (row["last_error"] or "")
        assert _balance(world, case) == before + 60


def test_an_unknown_status_is_retried(world: dict[str, Any]) -> None:
    case = _polling(world)
    assert _once(world, PollFake(statuses=[("unknown", [])]))
    row = _job_row(world, case.job)  # type: ignore[arg-type]
    assert (row["status"], row["attempts"]) == ("queued", 1)


def test_a_payload_without_a_provider_job_is_terminal(world: dict[str, Any]) -> None:
    case = _polling(world, transcriber_job_id="../../x")
    fake = PollFake()
    assert _once(world, fake)
    assert _meeting(world, case)[0] == "failed" and fake.polled == []
