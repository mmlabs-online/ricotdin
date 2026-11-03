"""ARC-08b: Speechmatics client + Transcriber over ``httpx2.MockTransport`` (no network): key
choice by jobs in flight, one key per job, retry/backoff, 401 → key unusable, other 4xx terminal,
size caps, no key in errors."""

import json
from pathlib import Path
from typing import Any

import anyio
import httpx2
import pytest

from app.services.keys.pool import KeyWithMeta
from app.services.keys.source import KeySource
from app.worker import speechmatics_client as sc
from app.worker.errors import PipelineError, TransientError
from app.worker.jobs import Submission
from app.worker.speechmatics import key_ref
from app.worker.speechmatics_client import (
    SpeechmaticsKeyRejected,
    SpeechmaticsTranscriber,
    backoff_s,
    mime_type,
)

K1 = KeyWithMeta("00000000-0000-0000-0000-0000000000a1", "sm-key-one")
K2 = KeyWithMeta(None, "sm-key-two")


class Server:
    def __init__(self, *answers: Any) -> None:
        self.answers = list(answers)
        self.requests: list[httpx2.Request] = []

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        request.read()
        self.requests.append(request)
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(answer, Exception):
            raise answer
        status, body = answer
        content = body if isinstance(body, bytes) else json.dumps(body).encode()
        return httpx2.Response(status, content=content)


class T(SpeechmaticsTranscriber):
    def __init__(self, server: Server, keys: list[KeyWithMeta]) -> None:
        self.source = KeySource(None, {})
        self.sleeps: list[float] = []

        async def sleep(s: float) -> None:
            self.sleeps.append(s)

        super().__init__(
            None,  # type: ignore[arg-type]  # _usable is overridden
            self.source,
            transport=httpx2.MockTransport(server.handle),
            sleep=sleep,
        )
        self.all_keys = keys

    async def _usable(self) -> list[KeyWithMeta]:
        return self.source.usable(self.all_keys)


def run(fn: Any) -> Any:
    return anyio.run(fn)


@pytest.fixture
def mp3(tmp_path: Path) -> Path:
    path = tmp_path / "upload.mp3"
    path.write_bytes(b"ID3fake-audio")
    return path


def test_backoff_and_mime() -> None:
    assert [backoff_s(n) for n in range(1, 8)] == [0.6, 1.2, 2.4, 4.8, 9.6, 10.0, 10.0]
    assert mime_type(Path("a.mp3")) == "audio/mpeg"
    assert mime_type(Path("a.WEBM")) == "audio/webm"
    assert mime_type(Path("a.bin")) == "application/octet-stream"


def test_submit_sends_the_file_and_config_with_the_least_busy_key(mp3: Path) -> None:
    server = Server((201, {"id": "job1"}), (201, {"id": "job2"}), (201, {"id": "job3"}))
    t = T(server, [K1, K2])

    async def go() -> list[Submission]:
        return [await t.submit(mp3, language=None, speaker_count=2) for _ in range(3)]

    subs = run(go)
    assert [s.job_id for s in subs] == ["job1", "job2", "job3"]
    assert [s.key_ref for s in subs] == [key_ref(K1), key_ref(K2), key_ref(K1)]
    assert t.in_flight(key_ref(K1)) == 2 and t.in_flight(key_ref(K2)) == 1
    first = server.requests[0]
    assert (first.method, first.url.path) == ("POST", "/v2/jobs")
    assert first.headers["authorization"] == "Bearer sm-key-one"
    body = first.content
    assert b"ID3fake-audio" in body and b'filename="audio.mp3"' in body
    assert b"audio/mpeg" in body
    assert b'"language": "auto"' in body and b'"max_speakers": 2' in body
    t.release(subs[0])
    t.release(subs[0])
    t.release(subs[0])  # never below zero
    assert t.in_flight(key_ref(K1)) == 0


def test_submit_with_language_en(mp3: Path) -> None:
    server = Server((201, {"id": "job1"}))
    run(lambda: T(server, [K1]).submit(mp3, language="en", speaker_count=None))
    assert b'"language": "en"' in server.requests[0].content
    assert b"max_speakers" not in server.requests[0].content


def test_429_and_5xx_and_network_errors_are_retried(mp3: Path) -> None:
    server = Server((429, {}), (503, {}), httpx2.ConnectError("reset"), (201, {"id": "job1"}))
    t = T(server, [K1])
    sub = run(lambda: t.submit(mp3, language=None, speaker_count=None))
    assert sub.job_id == "job1" and t.sleeps == [0.6, 1.2, 2.4]
    assert all(b"ID3fake-audio" in r.content for r in server.requests)  # file re-sent each time


def test_retries_exhausted_is_transient_and_frees_the_key(mp3: Path) -> None:
    t = T(Server((500, {})), [K1])
    with pytest.raises(TransientError, match="HTTP 500 after retries") as exc:
        run(lambda: t.submit(mp3, language=None, speaker_count=None))
    assert len(t.sleeps) == sc.MAX_ATTEMPTS - 1
    assert "sm-key" not in str(exc.value)
    assert t.in_flight(key_ref(K1)) == 0


def test_401_disables_the_key_and_the_next_submit_uses_another(mp3: Path) -> None:
    server = Server((401, {"detail": "bad key sm-key-one"}), (201, {"id": "job9"}))
    t = T(server, [K1, K2])
    with pytest.raises(SpeechmaticsKeyRejected) as exc:
        run(lambda: t.submit(mp3, language=None, speaker_count=None))
    assert isinstance(exc.value, TransientError)  # the step is retried
    assert "sm-key" not in str(exc.value)
    sub = run(lambda: t.submit(mp3, language=None, speaker_count=None))
    assert sub.key_ref == key_ref(K2)
    assert server.requests[1].headers["authorization"] == "Bearer sm-key-two"


def test_other_4xx_is_a_terminal_rejection(mp3: Path) -> None:
    t = T(Server((400, {"error": "bad audio"})), [K1])
    with pytest.raises(PipelineError) as exc:
        run(lambda: t.submit(mp3, language=None, speaker_count=None))
    assert str(exc.value) == sc.PROVIDER_REJECTED
    assert t.sleeps == [] and t.in_flight(key_ref(K1)) == 0


@pytest.mark.parametrize("body", [{"id": "../x"}, {}, [], b"not json"])
def test_a_bad_submit_answer_is_transient(mp3: Path, body: Any) -> None:
    t = T(Server((201, body)), [K1])
    with pytest.raises(TransientError):
        run(lambda: t.submit(mp3, language=None, speaker_count=None))
    assert t.in_flight(key_ref(K1)) == 0


def test_no_keys_is_transient(mp3: Path) -> None:
    with pytest.raises(TransientError, match="no usable Speechmatics"):
        run(
            lambda: T(Server((201, {"id": "x"})), []).submit(mp3, language=None, speaker_count=None)
        )


def test_status_and_transcript_use_the_job_key() -> None:
    server = Server(
        (200, {"job": {"id": "j", "status": "rejected", "errors": [{"message": "m"}]}}),
        (200, {"results": []}),
    )
    t = T(server, [K1, K2])
    sub = Submission("j", key_ref(K2))
    assert run(lambda: t.status(sub)) == ("rejected", [{"message": "m"}])
    assert run(lambda: t.transcript(sub)) == {"results": []}
    assert [r.headers["authorization"] for r in server.requests] == ["Bearer sm-key-two"] * 2
    assert server.requests[0].url.path == "/v2/jobs/j"
    assert server.requests[1].url.path == "/v2/jobs/j/transcript"
    assert server.requests[1].url.params["format"] == "json-v2"


def test_a_job_whose_key_is_gone_is_terminal() -> None:
    t = T(Server((200, {})), [K1])
    with pytest.raises(PipelineError):
        run(lambda: t.status(Submission("j", "id:00000000-0000-0000-0000-00000000dead")))


def test_an_oversized_transcript_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sc, "MAX_TRANSCRIPT_BYTES", 100)
    t = T(Server((200, b"x" * 500)), [K1])
    with pytest.raises(PipelineError, match="could not process"):
        run(lambda: t.transcript(Submission("j", key_ref(K1))))


def test_repr_hides_keys() -> None:
    t = T(Server((200, {})), [K1])
    assert repr(t) == "SpeechmaticsTranscriber()"
    assert "sm-key" not in repr(K1)
