"""Worker data types (ARC-08): the claimed job, what a step returns, the step context and the
transcriber contract (``speechmatics_client.SpeechmaticsTranscriber``)."""

import json
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol

from app.db.session import Database
from app.services.ai.service import AIService
from app.services.platform import Platform


@dataclass(frozen=True)
class Job:
    id: uuid.UUID
    meeting_id: uuid.UUID
    step: str
    attempts: int
    max_attempts: int
    payload: dict[str, Any]
    locked_by: str | None = None
    locked_at: datetime | None = None

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> "Job":
        payload = row["payload"]
        if isinstance(payload, str):  # asyncpg returns jsonb as text
            payload = json.loads(payload)
        return cls(
            id=row["id"],
            meeting_id=row["meeting_id"],
            step=row["step"],
            attempts=int(row["attempts"]),
            max_attempts=int(row["max_attempts"]),
            payload=dict(payload) if isinstance(payload, dict) else {},
            locked_by=row.get("locked_by"),
            locked_at=row.get("locked_at"),
        )


# --- step outcomes -----------------------------------------------------------------------------


@dataclass(frozen=True)
class Advance:
    """Queue the job again at ``step`` after ``delay_s``, merging ``payload`` into the job's."""

    step: str
    payload: dict[str, Any] = field(default_factory=dict)
    delay_s: float = 0.0


@dataclass(frozen=True)
class Done:
    """The job is finished. ``activity`` (event, metadata) is logged for the meeting owner."""

    payload: dict[str, Any] = field(default_factory=dict)
    activity: tuple[str, dict[str, Any]] | None = None
    # The step already closed the job (and logged its activity) in its own guarded transaction,
    # together with its last writes: the runner then writes nothing.
    closed: bool = False


@dataclass(frozen=True)
class Fail:
    """Expected terminal failure (e.g. quota blocked): job + meeting failed with ``message``,
    reserved quota refunded, activity ``processing_failed`` with ``metadata``."""

    message: str
    metadata: dict[str, Any] = field(default_factory=dict)


Outcome = Advance | Done | Fail


# --- transcriber ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class Submission:
    job_id: str  # the provider's job id
    key_ref: str | None = None  # which key holds the job (an id, never the key itself)


class Transcriber(Protocol):
    async def submit(
        self, audio: Path, *, language: str | None, speaker_count: int | None
    ) -> Submission: ...

    async def status(self, sub: Submission) -> tuple[str, list[Any]]:
        """``running`` | ``done`` | ``rejected`` | ``deleted`` | ``unknown`` and the errors."""
        ...

    async def transcript(self, sub: Submission) -> Any:
        """The raw json-v2 transcript of a ``done`` job (untrusted: parse defensively)."""
        ...

    def release(self, sub: Submission) -> None:
        """The provider job is finished: free its key slot."""
        ...


# --- step context -------------------------------------------------------------------------------


@dataclass
class StepContext:
    db: Database
    platform: Platform
    job: Job
    workdir: Path  # private temp directory, removed after the step
    transcriber: Transcriber | None
    now: Callable[[], datetime]
    worker_id: str  # guards the step's own job writes (locked_by)
    ai: AIService | None = None  # generation calls (analyse)


StepHandler = Callable[[StepContext], Awaitable[Outcome]]
