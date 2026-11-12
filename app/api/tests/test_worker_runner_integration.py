"""ARC-08 08a: the job runner and the ``start`` step end to end, as ``ricotdin_worker`` (its own
login, explicit allow-list from migration 0005) against a scratch database, a fake Google Drive
(tests/fake_drive.py) and a fake transcriber. Audio is generated with ffmpeg."""

import json
import secrets
import shutil
import subprocess
import uuid
from collections.abc import Awaitable, Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import anyio
import psycopg
import pytest

from app.core.settings import Settings
from app.db.provision import drop_login, ensure_login
from app.db.scratch import admin_url, scratch_database
from app.db.session import Database
from app.services.crypto import encrypt_with_key
from app.services.platform import Platform
from app.worker import audio
from app.worker.errors import TransientError
from app.worker.jobs import Done, Outcome, StepContext, StepHandler, Submission
from app.worker.messages import DEADLINE_EXCEEDED, GENERIC_FAILURE, MEETING_TIMED_OUT
from app.worker.runner import JobRunner
from app.worker.steps import default_steps
from tests.conftest import alembic_upgrade, requires_db
from tests.fake_drive import CONFIG, ROOT, FakeDrive, FakeFile

pytestmark = [
    requires_db,
    pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed"),
]

MASTER = bytes(range(32))


class _Url(str):
    def __repr__(self) -> str:
        return "<database url>"


def _sql(url: str, query: str, *args: Any) -> list[tuple[Any, ...]]:
    with psycopg.connect(url, autocommit=True) as conn:
        cur = conn.execute(query, args)
        return cur.fetchall() if cur.description else []


def _media(tmp: Path, name: str, *, seconds: float = 2.0, video: bool = False) -> bytes:
    path = tmp / name
    args = ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi",
            "-i", f"sine=frequency=440:duration={seconds}"]  # fmt: skip
    if video:
        args += ["-f", "lavfi", "-i", f"testsrc=size=64x48:rate=5:duration={seconds}"]
    subprocess.run([*args, str(path)], check=True)  # noqa: S603 - fixed test command
    return path.read_bytes()


@pytest.fixture(scope="module")
def world(tmp_path_factory: pytest.TempPathFactory) -> Iterator[dict[str, Any]]:
    owner = admin_url()
    tmp = tmp_path_factory.mktemp("media")
    with scratch_database("worker") as raw:
        url = _Url(raw)
        alembic_upgrade(url)
        login = ensure_login(
            owner, "ricotdin_worker", f"ricotdin_test_wrun_{secrets.token_hex(3)}",
            connection_limit=5,
        )  # fmt: skip
        try:
            sec = encrypt_with_key(CONFIG.client_secret, MASTER)
            ref = encrypt_with_key(CONFIG.refresh_token, MASTER)
            _sql(
                url,
                "INSERT INTO drive_config (client_id, client_secret_ciphertext, client_secret_iv, "
                "client_secret_auth_tag, refresh_token_ciphertext, refresh_token_iv, "
                "refresh_token_auth_tag, root_folder_id, account_email) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                CONFIG.client_id, sec.ciphertext, sec.iv, sec.auth_tag,
                ref.ciphertext, ref.iv, ref.auth_tag, ROOT, CONFIG.account_email,
            )  # fmt: skip
            drive = FakeDrive()
            drive.files[ROOT] = FakeFile(
                {"id": ROOT, "mimeType": "application/vnd.google-apps.folder"}
            )
            yield {
                "db": url,
                "worker": _Url(login.url(url)),
                "drive": drive,
                "webm": _media(tmp, "a.webm", seconds=1.5),
                "mp4": _media(tmp, "v.mp4", video=True),
            }
        finally:
            drop_login(owner, login.name)


@pytest.fixture(autouse=True)
def _no_ready_jobs(world: dict[str, Any]) -> None:
    """claim_next_job takes the oldest ready job of the database: start every test empty."""
    _sql(world["db"], "UPDATE jobs SET status = 'done' WHERE status IN ('queued', 'running')")


# --- seeding ------------------------------------------------------------------------------------


@dataclass
class Case:
    user: uuid.UUID
    meeting: uuid.UUID
    key: str
    job: uuid.UUID | None = None


def _seed(
    world: dict[str, Any], *, balance: int = 3600, source: str = "recorded",
    data: bytes | None = None, ext: str = ".webm", status: str = "pending",
    provider: str = "gdrive", audio_path: str | None = "own", mapped: bool = True,
    duration: int | None = None,
) -> Case:  # fmt: skip
    db = world["db"]
    user, meeting = uuid.uuid4(), uuid.uuid4()
    _sql(
        db,
        "INSERT INTO users (id, email, password_hash, role) VALUES (%s, %s, 'x', 'user')",
        user,
        f"{user.hex[:12]}@example.test",
    )
    _sql(db, "INSERT INTO profiles (id, username) VALUES (%s, %s)", user, f"u{user.hex[:12]}")
    _sql(
        db,
        "INSERT INTO quota_wallets (user_id, audio_seconds_remaining) VALUES (%s, %s)",
        user,
        balance,
    )
    key = f"{user}/{meeting}{ext}"
    path = key if audio_path == "own" else audio_path
    _sql(
        db,
        "INSERT INTO meetings (id, user_id, status, source, storage_provider, audio_path, "
        "duration_seconds) VALUES (%s, %s, %s, %s, %s, %s, %s)",
        meeting, user, status, source, provider, path, duration,
    )  # fmt: skip
    if mapped:
        body = world["webm"] if data is None else data
        fid = world["drive"].add_file(body, key=key)
        _sql(
            db,
            "INSERT INTO storage_objects (key, file_id, size_bytes, content_type) "
            "VALUES (%s, %s, %s, 'audio/webm')",
            key,
            fid,
            len(body),
        )
    return Case(user, meeting, key)


def _job(world: dict[str, Any], case: Case, *, step: str = "start", **cols: Any) -> uuid.UUID:
    payload = json.dumps(cols.pop("payload", {}))
    names = ["meeting_id", "step", "payload", *cols]
    values = [case.meeting, step, payload, *cols.values()]
    marks = ", ".join(["%s"] * len(values))
    row = _sql(
        world["db"],
        f"INSERT INTO jobs ({', '.join(names)}) VALUES ({marks}) RETURNING id",  # noqa: S608
        *values,
    )
    case.job = row[0][0]
    return case.job


def _reserved(world: dict[str, Any], case: Case, job: uuid.UUID, seconds: int) -> None:
    """A reserve this job made earlier (ledger row + wallet), as the pipeline would have."""
    _sql(
        world["db"],
        "INSERT INTO quota_ledger (user_id, delta_audio_seconds, reason, dedup_key, meeting_id) "
        "VALUES (%s, %s, 'generate', %s, %s)",
        case.user, -seconds, f"gen:{job}:reserve", case.meeting,
    )  # fmt: skip
    _sql(
        world["db"],
        "UPDATE quota_wallets SET audio_seconds_remaining = audio_seconds_remaining - %s "
        "WHERE user_id = %s",
        seconds,
        case.user,
    )


def _job_row(world: dict[str, Any], job: uuid.UUID) -> dict[str, Any]:
    with psycopg.connect(world["db"], autocommit=True) as conn:
        cur = conn.execute(
            "SELECT step, status, attempts, last_error, payload, locked_by, "
            "run_after > now() AS later FROM jobs WHERE id = %s",
            (job,),
        )
        names = [c.name for c in cur.description or []]
        row = cur.fetchone()
    assert row is not None
    return dict(zip(names, row, strict=True))


def _meeting(world: dict[str, Any], case: Case) -> tuple[str, str | None]:
    row = _sql(
        world["db"], "SELECT status, error_message FROM meetings WHERE id = %s", case.meeting
    )
    return row[0][0], row[0][1]


def _balance(world: dict[str, Any], case: Case) -> int:
    row = _sql(
        world["db"],
        "SELECT audio_seconds_remaining FROM quota_wallets WHERE user_id = %s",
        case.user,
    )
    return int(row[0][0])


def _ledger(world: dict[str, Any], case: Case) -> list[tuple[str, int]]:
    rows = _sql(
        world["db"],
        "SELECT dedup_key, delta_audio_seconds FROM quota_ledger WHERE user_id = %s "
        "ORDER BY created_at",
        case.user,
    )
    return [(r[0], int(r[1])) for r in rows]


def _activity(world: dict[str, Any], case: Case) -> list[tuple[str, dict[str, Any]]]:
    rows = _sql(
        world["db"],
        "SELECT event_type, metadata FROM activity_log WHERE meeting_id = %s ORDER BY created_at",
        case.meeting,
    )
    return [(r[0], r[1]) for r in rows]


# --- running --------------------------------------------------------------------------------------


@dataclass
class FakeTranscriber:
    fail: list[Exception] = field(default_factory=list)
    calls: list[dict[str, Any]] = field(default_factory=list)

    async def submit(
        self, audio_path: Path, *, language: str | None, speaker_count: int | None
    ) -> Submission:
        if self.fail:
            raise self.fail.pop(0)
        probed = await audio.probe(audio_path)
        self.calls.append(
            {"name": audio_path.name,
             "streams": [(s["codec_type"], s["codec_name"]) for s in probed["streams"]]}
        )  # fmt: skip
        return Submission(f"sm-job-{len(self.calls)}", "key-ref-1")


def _run(
    world: dict[str, Any],
    body: Callable[[Callable[..., JobRunner]], Awaitable[Any]],
) -> Any:
    settings = Settings.model_validate(
        {"DATABASE_URL_WORKER": world["worker"], "KEY_ENCRYPTION_SECRET": MASTER.hex()}
    )
    settings.db_pool_worker = (2, 0)

    async def go() -> Any:
        db = await Database.start(settings)
        platform = Platform.from_settings(settings, env={})
        platform.drive_transport = world["drive"].transport()
        assert db.groups == {"ricotdin_worker"}

        def runner(
            transcriber: Any = None, steps: dict[str, StepHandler] | None = None, **kw: Any
        ) -> JobRunner:
            return JobRunner(
                db, platform, default_steps() if steps is None else steps,
                transcriber=transcriber, rand=lambda: 0.5, **kw,
            )  # fmt: skip

        try:
            return await body(runner)
        finally:
            await platform.aclose()
            await db.close()

    return anyio.run(go)


def _once(world: dict[str, Any], transcriber: Any = None, **kw: Any) -> bool:
    async def body(runner: Callable[..., JobRunner]) -> bool:
        return await runner(transcriber, **kw).run_once()

    result: bool = _run(world, body)
    return result


# --- tests: claim ----------------------------------------------------------------------------------


def test_nothing_to_do(world: dict[str, Any]) -> None:
    assert _once(world, FakeTranscriber()) is False


def test_two_workers_never_claim_the_same_job(world: dict[str, Any]) -> None:
    case = _seed(world)
    _job(world, case)

    async def body(runner: Callable[..., JobRunner]) -> list[Any]:
        a, b = runner(), runner()
        got: list[Any] = []

        async def claim(r: JobRunner) -> None:
            got.append(await r.claim())

        async with anyio.create_task_group() as tg:
            tg.start_soon(claim, a)
            tg.start_soon(claim, b)
        return got

    got = _run(world, body)
    assert sorted(j is None for j in got) == [False, True]
    claimed = next(j for j in got if j is not None)
    assert claimed.id == case.job and claimed.locked_by is not None


# --- tests: start step ---------------------------------------------------------------------------


def test_start_reserves_quota_transcodes_submits_and_advances(world: dict[str, Any]) -> None:
    case = _seed(world, balance=100)
    job = _job(world, case, payload={"speaker_count": 2})
    t = FakeTranscriber()
    assert _once(world, t) is True
    row = _job_row(world, job)
    assert (row["step"], row["status"], row["attempts"], row["locked_by"]) == (
        "transcribe_poll", "queued", 0, None,
    )  # fmt: skip
    assert row["later"] is True  # first poll after 5 s
    p = row["payload"]
    assert p["user_id"] == str(case.user) and p["estimate_seconds"] == 2
    assert p["reserve_done"] is True and p["transcription_settled"] is False
    assert p["transcriber_job_id"] == "sm-job-1" and p["transcriber_key_ref"] == "key-ref-1"
    assert p["speaker_count"] == 2 and datetime.fromisoformat(p["started_at"])
    assert t.calls == [{"name": "audio.mp3", "streams": [("audio", "mp3")]}]
    assert _meeting(world, case) == ("processing", None)
    assert _balance(world, case) == 98
    assert _ledger(world, case) == [(f"gen:{job}:reserve", -2)]


def test_a_rerun_of_the_same_job_is_charged_once(world: dict[str, Any]) -> None:
    # REL-03 / QUO-04: a restart after the reserve (meeting already processing) continues.
    case = _seed(world, balance=100)
    job = _job(world, case)
    t = FakeTranscriber()
    _once(world, t)
    _sql(world["db"], "UPDATE jobs SET step = 'start', status = 'queued', run_after = now() "
         "WHERE id = %s", job)  # fmt: skip
    _once(world, t)
    assert len(t.calls) == 2 and _job_row(world, job)["step"] == "transcribe_poll"
    assert _balance(world, case) == 98
    assert _ledger(world, case) == [(f"gen:{job}:reserve", -2)]


def test_a_new_job_for_the_same_meeting_is_charged_again(world: dict[str, Any]) -> None:
    # Owner decision 2026-11-02: requeue / reprocess charges again (v1 keyed by meeting: free).
    case = _seed(world, balance=100)
    first = _job(world, case)
    _once(world, FakeTranscriber())
    _sql(world["db"], "UPDATE jobs SET status = 'failed' WHERE id = %s", first)
    _sql(world["db"], "UPDATE meetings SET status = 'failed' WHERE id = %s", case.meeting)
    second = _job(world, case)
    _once(world, FakeTranscriber())
    assert _balance(world, case) == 96
    assert _ledger(world, case) == [(f"gen:{first}:reserve", -2), (f"gen:{second}:reserve", -2)]


def test_quota_blocked_fails_without_retry_or_refund(world: dict[str, Any]) -> None:
    case = _seed(world, balance=1)
    job = _job(world, case)
    t = FakeTranscriber()
    _once(world, t)
    row = _job_row(world, job)
    msg = "QUOTA_BLOCKED: Insufficient audio balance. Required: 2s, remaining: 1s."
    assert (row["status"], row["attempts"], row["last_error"]) == ("failed", 0, msg)
    assert _meeting(world, case) == ("failed", msg)
    assert t.calls == [] and _ledger(world, case) == [] and _balance(world, case) == 1
    assert _activity(world, case) == [
        ("processing_failed",
         {"reason": "quota_blocked", "required_seconds": 2, "remaining_seconds": 1})
    ]  # fmt: skip


def test_client_duration_is_the_estimate_when_the_file_has_none(world: dict[str, Any]) -> None:
    # Like a live-mode MediaRecorder WebM: written to a pipe, so no duration header.
    args = ["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "sine=duration=1",
            "-c:a", "libopus", "-f", "webm", "pipe:1"]  # fmt: skip
    raw = subprocess.run(args, check=True, capture_output=True).stdout  # noqa: S603
    case = _seed(world, data=raw, duration=42)
    job = _job(world, case)
    _once(world, FakeTranscriber())
    assert _job_row(world, job)["payload"]["estimate_seconds"] == 42
    assert _ledger(world, case) == [(f"gen:{job}:reserve", -42)]


def test_video_meetings_extract_the_audio_track(world: dict[str, Any]) -> None:
    case = _seed(world, source="video", data=world["mp4"], ext=".mp4")
    job = _job(world, case)
    t = FakeTranscriber()
    _once(world, t)
    assert _job_row(world, job)["step"] == "transcribe_poll"
    assert t.calls == [{"name": "extracted.mp3", "streams": [("audio", "mp3")]}]


def test_video_in_an_audio_meeting_is_terminal(world: dict[str, Any]) -> None:
    case = _seed(world, data=world["mp4"])
    job = _job(world, case)
    _once(world, FakeTranscriber())
    row = _job_row(world, job)
    assert (row["status"], row["attempts"]) == ("failed", 1)
    status, message = _meeting(world, case)
    assert status == "failed" and message is not None and "video stream" in message
    assert _ledger(world, case) == []


def test_a_file_that_is_not_media_is_terminal(world: dict[str, Any]) -> None:
    case = _seed(world, data=b"not audio at all" * 64)
    job = _job(world, case)
    _once(world, FakeTranscriber())
    row = _job_row(world, job)
    assert (row["status"], row["attempts"]) == ("failed", 1)
    # Users see a fixed text; the ffprobe detail stays in jobs.last_error (review round 1).
    assert _meeting(world, case)[1] == (
        "The file could not be read. Please upload a valid audio or video file."
    )
    assert "ffprobe failed to analyse the file" in row["last_error"]
    assert _activity(world, case)[0][0] == "processing_failed"


@pytest.mark.parametrize(
    ("kwargs", "fragment"),
    [
        ({"audio_path": "someone-else/abc.webm"}, "does not belong to this meeting"),
        ({"provider": "r2"}, "not gdrive"),
        ({"mapped": False}, "unmapped"),
    ],
)
def test_terminal_start_errors_fail_at_once(
    world: dict[str, Any], kwargs: dict[str, Any], fragment: str
) -> None:
    case = _seed(world, **kwargs)
    job = _job(world, case)
    _once(world, FakeTranscriber())
    row = _job_row(world, job)
    assert (row["status"], row["attempts"]) == ("failed", 1)
    status, message = _meeting(world, case)
    assert status == "failed" and fragment not in (message or "")  # detail is admin-only
    assert fragment in row["last_error"]
    assert _activity(world, case) == [("processing_failed", {"error": message})]


def test_missing_audio_path_is_retried_like_v1(world: dict[str, Any]) -> None:
    case = _seed(world, audio_path=None)
    job = _job(world, case)
    _once(world, FakeTranscriber())
    row = _job_row(world, job)
    assert (row["status"], row["attempts"], row["later"]) == ("queued", 1, True)
    assert "no audio_path" in row["last_error"]
    assert _meeting(world, case)[0] == "pending"  # the claim is rolled back with the error


def test_a_meeting_that_is_done_ends_the_job(world: dict[str, Any]) -> None:
    case = _seed(world, status="done")
    job = _job(world, case)
    t = FakeTranscriber()
    _once(world, t)
    assert _job_row(world, job)["status"] == "done"
    assert _meeting(world, case) == ("done", None) and t.calls == []


def test_without_a_transcriber_the_job_fails_and_refunds(world: dict[str, Any]) -> None:
    case = _seed(world, balance=50)
    job = _job(world, case)
    _once(world, None)
    assert _job_row(world, job)["status"] == "failed"
    assert _balance(world, case) == 50
    assert _ledger(world, case) == [(f"gen:{job}:reserve", -2), (f"gen:{job}:refund", 2)]


# --- tests: retries, refunds ---------------------------------------------------------------------


def test_transient_errors_back_off_then_fail_with_one_refund(world: dict[str, Any]) -> None:
    case = _seed(world, balance=50)
    job = _job(world, case)
    _once(world, FakeTranscriber(fail=[TransientError("provider down")]))
    row = _job_row(world, job)
    assert (row["step"], row["status"], row["attempts"], row["later"]) == (
        "start", "queued", 1, True,
    )  # fmt: skip
    assert row["last_error"] == "TransientError: provider down"
    assert row["payload"]["reserve_done"] is True  # recorded with the reserve
    assert _balance(world, case) == 48
    # last attempt
    _sql(world["db"], "UPDATE jobs SET attempts = 4, run_after = now() WHERE id = %s", job)
    _once(world, FakeTranscriber(fail=[TransientError("provider down")]))
    row = _job_row(world, job)
    assert (row["status"], row["attempts"]) == ("failed", 5)
    assert _meeting(world, case) == ("failed", GENERIC_FAILURE)
    assert row["last_error"] == "TransientError: provider down"
    assert _balance(world, case) == 50
    assert _ledger(world, case) == [(f"gen:{job}:reserve", -2), (f"gen:{job}:refund", 2)]
    assert _activity(world, case) == [("processing_failed", {"error": GENERIC_FAILURE})]


def test_unknown_step_is_terminal_and_refunds(world: dict[str, Any]) -> None:
    case = _seed(world, balance=10)
    payload = {"reserve_done": True, "estimate_seconds": 4, "user_id": str(case.user)}
    job = _job(world, case, step="embed", payload=payload)
    _reserved(world, case, job, 4)
    steps = {k: v for k, v in default_steps().items() if k != "embed"}  # a step the worker lacks
    _once(world, FakeTranscriber(), steps=steps)
    row = _job_row(world, job)
    assert (row["status"], row["attempts"], row["last_error"]) == (
        "failed", 1, f"{GENERIC_FAILURE} — Unknown job step: embed",
    )  # fmt: skip
    assert _meeting(world, case) == ("failed", GENERIC_FAILURE)
    assert _balance(world, case) == 10  # the reserve came back
    assert sorted(_ledger(world, case)) == [(f"gen:{job}:refund", 4), (f"gen:{job}:reserve", -4)]


def test_payload_claims_without_a_ledger_reserve_refund_nothing(world: dict[str, Any]) -> None:
    # Review round 1: amounts come from the ledger, never the payload (e.g. a v1 job copied by
    # ARC-03 whose reserve is keyed by meeting: no free refund).
    case = _seed(world, balance=10)
    payload = {"reserve_done": True, "estimate_seconds": 500, "user_id": str(case.user)}
    _job(world, case, step="analyse", payload=payload)
    _once(world, FakeTranscriber())
    assert _balance(world, case) == 10 and _ledger(world, case) == []


def test_settled_jobs_are_not_refunded(world: dict[str, Any]) -> None:
    case = _seed(world, balance=10)
    payload = {"reserve_done": True, "transcription_settled": True, "estimate_seconds": 4,
               "user_id": str(case.user)}  # fmt: skip
    job = _job(world, case, step="embed", payload=payload)
    _reserved(world, case, job, 4)
    _sql(world["db"], "INSERT INTO quota_ledger (user_id, delta_audio_seconds, reason, dedup_key) "
         "VALUES (%s, 0, 'generate', %s)", case.user, f"gen:{job}:settle")  # fmt: skip
    _once(world, FakeTranscriber())
    assert _balance(world, case) == 6 and len(_ledger(world, case)) == 2  # no refund


def test_the_pipeline_deadline_fails_the_job_with_a_refund(world: dict[str, Any]) -> None:
    case = _seed(world, balance=10)
    started = (datetime.now(UTC) - timedelta(hours=7)).isoformat()
    payload = {"reserve_done": True, "estimate_seconds": 3, "user_id": str(case.user),
               "started_at": started}  # fmt: skip
    job = _job(world, case, step="transcribe_poll", payload=payload)
    _reserved(world, case, job, 3)
    called: list[str] = []

    async def poll(ctx: StepContext) -> Outcome:
        called.append("poll")
        return Done()

    _once(world, FakeTranscriber(), steps={"transcribe_poll": poll})
    assert called == []
    assert _job_row(world, job)["status"] == "failed"
    assert _meeting(world, case) == ("failed", DEADLINE_EXCEEDED)
    assert _balance(world, case) == 10
    assert _activity(world, case) == [("processing_failed", {"reason": "deadline"})]


def test_a_step_past_its_timeout_is_retried(world: dict[str, Any]) -> None:
    case = _seed(world)
    job = _job(world, case)

    async def slow(ctx: StepContext) -> Outcome:
        await anyio.sleep(30)
        return Done()

    _once(world, steps={"start": slow}, step_timeout_s=0.2)
    row = _job_row(world, job)
    assert (row["status"], row["attempts"], row["last_error"]) == ("queued", 1, "TimeoutError")


def test_done_outcome_logs_activity(world: dict[str, Any]) -> None:
    case = _seed(world)
    job = _job(world, case)

    async def finish(ctx: StepContext) -> Outcome:
        return Done({"segments": 3}, activity=("processing_done", {"segments": 3}))

    _once(world, steps={"start": finish})
    row = _job_row(world, job)
    assert row["status"] == "done" and row["payload"] == {"segments": 3}
    assert _activity(world, case) == [("processing_done", {"segments": 3})]


def test_a_job_taken_back_by_the_sweeper_is_not_overwritten(world: dict[str, Any]) -> None:
    case = _seed(world)
    job = _job(world, case)

    async def swept(ctx: StepContext) -> Outcome:
        _sql(world["db"], "UPDATE jobs SET status = 'queued', locked_by = NULL WHERE id = %s", job)
        return Done()

    _once(world, steps={"start": swept})
    assert _job_row(world, job)["status"] == "queued"


def test_cancelled_step_releases_the_job(world: dict[str, Any]) -> None:
    case = _seed(world)
    job = _job(world, case, attempts=2)
    started = anyio.Event()

    async def hang(ctx: StepContext) -> Outcome:
        started.set()
        await anyio.sleep(60)
        return Done()

    async def body(runner: Callable[..., JobRunner]) -> None:
        r = runner(steps={"start": hang})
        async with anyio.create_task_group() as tg:
            tg.start_soon(r.run_once)
            await started.wait()
            tg.cancel_scope.cancel()

    _run(world, body)
    row = _job_row(world, job)
    assert (row["status"], row["attempts"], row["locked_by"], row["later"]) == (
        "queued", 2, None, False,
    )  # fmt: skip


def test_workdir_is_removed_after_the_step(world: dict[str, Any]) -> None:
    case = _seed(world)
    _job(world, case)
    seen: list[Path] = []

    async def look(ctx: StepContext) -> Outcome:
        seen.append(ctx.workdir)
        (ctx.workdir / "x").write_bytes(b"1")
        return Done()

    _once(world, steps={"start": look})
    assert seen and not seen[0].exists()


# --- tests: stuck sweep --------------------------------------------------------------------------


def test_sweep_requeues_a_stuck_start_and_resets_the_meeting(world: dict[str, Any]) -> None:
    case = _seed(world, status="processing")
    job = _job(world, case, status="running", locked_by="dead",
               locked_at=datetime.now(UTC) - timedelta(minutes=20))  # fmt: skip
    fresh = _seed(world, status="processing")
    fresh_job = _job(world, fresh, status="running", locked_by="alive",
                     locked_at=datetime.now(UTC) - timedelta(minutes=2))  # fmt: skip

    async def body(runner: Callable[..., JobRunner]) -> int:
        return await runner().sweep_stuck()

    assert _run(world, body) == 1
    row = _job_row(world, job)
    assert (row["status"], row["attempts"], row["locked_by"], row["later"]) == (
        "queued", 1, None, False,
    )  # fmt: skip
    assert row["last_error"] == "Requeued after stuck timeout (attempt 1/5)"
    assert _meeting(world, case)[0] == "pending"
    assert _job_row(world, fresh_job)["status"] == "running"


def test_sweep_fails_an_exhausted_job_with_refund_and_activity(world: dict[str, Any]) -> None:
    case = _seed(world, balance=0, status="processing")
    payload = {"reserve_done": True, "estimate_seconds": 30, "user_id": str(case.user)}
    job = _job(world, case, step="transcribe_poll", status="running", attempts=4,
               locked_by="dead", locked_at=datetime.now(UTC) - timedelta(minutes=30),
               payload=payload)  # fmt: skip
    _sql(world["db"], "UPDATE quota_wallets SET audio_seconds_remaining = 30 WHERE user_id = %s",
         case.user)  # fmt: skip
    _reserved(world, case, job, 30)

    async def body(runner: Callable[..., JobRunner]) -> int:
        return await runner().sweep_stuck()

    _run(world, body)
    row = _job_row(world, job)
    assert (row["status"], row["attempts"]) == ("failed", 5)
    assert _meeting(world, case) == ("failed", MEETING_TIMED_OUT)
    assert _balance(world, case) == 30
    assert sorted(_ledger(world, case)) == [(f"gen:{job}:refund", 30), (f"gen:{job}:reserve", -30)]
    assert _activity(world, case) == [("processing_failed", {"reason": "stuck_timeout"})]


def test_run_forever_works_through_the_queue_and_stops(world: dict[str, Any]) -> None:
    cases = [_seed(world) for _ in range(2)]
    jobs = [_job(world, c) for c in cases]
    t = FakeTranscriber()
    stop = anyio.Event()

    class Stopping(FakeTranscriber):
        async def submit(
            self, audio_path: Path, *, language: str | None, speaker_count: int | None
        ) -> Submission:
            out = await t.submit(audio_path, language=language, speaker_count=speaker_count)
            if len(t.calls) == 2:
                stop.set()
            return out

    async def body(runner: Callable[..., JobRunner]) -> None:
        r = runner(Stopping(), poll_interval_s=0.05)
        with anyio.fail_after(30):
            await r.run_forever(stop)

    _run(world, body)
    assert [_job_row(world, j)["step"] for j in jobs] == ["transcribe_poll"] * 2


# --- review round 1 -------------------------------------------------------------------------------


def test_a_lock_lost_during_start_rolls_back_the_reserve(
    world: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    case = _seed(world, balance=50)
    job = _job(world, case)
    real = audio.inspect

    async def swept_meanwhile(path: Path, mode: Any) -> float:
        _sql(world["db"], "UPDATE jobs SET locked_by = 'other-worker' WHERE id = %s", job)
        return await real(path, mode)

    monkeypatch.setattr(audio, "inspect", swept_meanwhile)
    t = FakeTranscriber()
    _once(world, t)
    assert t.calls == [] and _ledger(world, case) == [] and _balance(world, case) == 50
    row = _job_row(world, job)
    assert (row["status"], row["locked_by"], row["attempts"]) == ("running", "other-worker", 0)


def test_a_retry_with_no_estimate_keeps_reserve_done(
    world: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    case = _seed(world, balance=50)
    job = _job(world, case)
    _once(world, FakeTranscriber(fail=[TransientError("down")]))
    assert _job_row(world, job)["payload"]["reserve_done"] is True
    _sql(world["db"], "UPDATE jobs SET run_after = now() WHERE id = %s", job)

    async def unknown(path: Path, mode: Any) -> float:
        return 0.0

    monkeypatch.setattr(audio, "inspect", unknown)
    _once(world, FakeTranscriber())
    row = _job_row(world, job)
    assert row["step"] == "transcribe_poll" and row["payload"]["reserve_done"] is True
    assert row["payload"]["estimate_seconds"] == 0


def test_a_failed_job_never_flips_a_done_meeting(world: dict[str, Any]) -> None:
    case = _seed(world, status="done")
    _job(world, case, step="analyse")
    _once(world, FakeTranscriber())
    assert _meeting(world, case) == ("done", None)


def test_audio_longer_than_six_hours_is_refused(world: dict[str, Any]) -> None:
    raw = subprocess.run(  # noqa: S603 - pipe output: no duration header, client says 7 h
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i",  # noqa: S607
         "sine=duration=1", "-c:a", "libopus", "-f", "webm", "pipe:1"],
        check=True, capture_output=True,
    ).stdout  # fmt: skip
    case = _seed(world, data=raw, duration=7 * 3600)
    job = _job(world, case)
    _once(world, FakeTranscriber())
    assert _job_row(world, job)["status"] == "failed" and _ledger(world, case) == []
    assert "longer than 6 hours" in (_meeting(world, case)[1] or "")


def test_stale_job_temp_dirs_are_removed_at_startup(world: dict[str, Any], tmp_path: Path) -> None:
    import os

    old, new, other = (tmp_path / n for n in ("ricotdin-job-old", "ricotdin-job-new", "keep"))
    for d in (old, new, other):
        d.mkdir()
    os.utime(old, (0, 0))
    os.utime(other, (0, 0))

    async def body(runner: Callable[..., JobRunner]) -> list[str]:
        return runner(tmp_root=tmp_path).remove_stale_workdirs()

    assert _run(world, body) == ["ricotdin-job-old"]
    assert not old.exists() and new.exists() and other.exists()
