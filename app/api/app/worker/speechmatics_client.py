"""Speechmatics Batch API client and the worker's ``Transcriber`` (ARC-08b; port of v1
``lib/speechmatics/{client,transcribe,pool}.ts``).

* Keys come from ``KeySource`` (``admin_config``, env fallback), read in a short
  ``ricotdin_worker`` transaction. One job keeps one key from submit to transcript: the job
  payload stores ``key_ref`` (an id or hash, never the key). A new job takes the key with the
  fewest jobs in flight in this process; the counts survive a key-set reload (they are kept
  per ``key_ref``), so the pool is never rebuilt per request.
* Retries 429 / 5xx / network errors with backoff (0.6 s doubling to 10 s, 8 attempts, v1), then
  ``TransientError`` (the runner retries the step). 401 marks the key unusable process-wide
  (``KeySource.mark_invalid``). Other 4xx are a provider rejection (terminal).
* Error texts carry the HTTP status only: never the key, the URL query or the response body.
"""

import json
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import anyio
import httpx2

from app.core.logging import get_logger
from app.db.session import Database
from app.services.keys.pool import KeyWithMeta
from app.services.keys.source import KeySource
from app.worker.errors import PipelineError, TransientError
from app.worker.jobs import Submission
from app.worker.speechmatics import (
    MAX_TRANSCRIPT_BYTES,
    build_job_config,
    key_ref,
    parse_job_status,
    safe_job_id,
)

log = get_logger("worker.speechmatics")

BASE_URL = "https://asr.api.speechmatics.com"
MAX_ATTEMPTS = 8
BASE_BACKOFF_S = 0.6
MAX_BACKOFF_S = 10.0
_MAX_STATUS_BYTES = 1024 * 1024
_MIME = {
    ".webm": "audio/webm", ".mp4": "audio/mp4", ".ogg": "audio/ogg", ".wav": "audio/wav",
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".flac": "audio/flac", ".aac": "audio/aac",
}  # fmt: skip
PROVIDER_REJECTED = "The transcription service could not process this recording."

Sleep = Callable[[float], Awaitable[None]]


class SpeechmaticsKeyRejected(TransientError):
    """401: the key is invalid. A submit is retried with another key; a job created with this
    key can no longer be reached (``transcribe_poll`` makes that terminal)."""


def backoff_s(attempt: int) -> float:
    """Wait before retry ``attempt`` (1-based): 0.6, 1.2, 2.4, 4.8, 9.6, 10, 10 … s (v1)."""
    return float(min(BASE_BACKOFF_S * 2 ** (attempt - 1), MAX_BACKOFF_S))


def mime_type(path: Path) -> str:
    return _MIME.get(path.suffix.lower(), "application/octet-stream")


class SpeechmaticsTranscriber:
    def __init__(
        self,
        db: Database,
        keys: KeySource,
        *,
        transport: httpx2.AsyncBaseTransport | None = None,
        sleep: Sleep = anyio.sleep,
        base_url: str = BASE_URL,
    ) -> None:
        self._db = db
        self._keys = keys
        self._sleep = sleep
        self._base = base_url
        self._http = httpx2.AsyncClient(
            transport=transport,
            timeout=httpx2.Timeout(30.0, read=120.0, write=600.0),
            follow_redirects=False,
        )
        self._pending: dict[str, int] = {}  # submits in progress, per key_ref
        self._jobs: dict[str, str] = {}  # provider job id → key_ref, until released

    def __repr__(self) -> str:
        return "SpeechmaticsTranscriber()"

    async def aclose(self) -> None:
        await self._http.aclose()

    # --- keys -----------------------------------------------------------------------------------

    async def _usable(self) -> list[KeyWithMeta]:
        async with self._db.role_transaction("ricotdin_worker") as conn:
            return await self._keys.active_keys(conn, "speechmatics")

    async def _acquire(self) -> KeyWithMeta:
        keys = await self._usable()
        if not keys:
            raise TransientError("no usable Speechmatics API key (admin keys or env)")
        chosen = min(keys, key=lambda k: self.in_flight(key_ref(k)))
        ref = key_ref(chosen)
        self._pending[ref] = self._pending.get(ref, 0) + 1
        return chosen

    def _unpend(self, ref: str) -> None:
        if self._pending.get(ref, 0) > 0:
            self._pending[ref] -= 1

    async def _key_for(self, sub: Submission) -> KeyWithMeta:
        for key in await self._usable():
            if key_ref(key) == sub.key_ref:
                return key
        # Transient: a short admin_config read failure falls back to env keys (KeySource), and a
        # disabled key may be enabled again. The runner's attempts and the 6 h deadline bound it.
        raise TransientError("the Speechmatics key that holds this job is not usable right now")

    def release(self, sub: Submission) -> None:
        """The provider job is finished (or abandoned): free its key slot. Only jobs submitted by
        this process count; a second release of the same job does nothing."""
        self._jobs.pop(sub.job_id, None)

    def in_flight(self, ref: str) -> int:
        return self._pending.get(ref, 0) + sum(1 for r in self._jobs.values() if r == ref)

    async def _request(
        self,
        key: KeyWithMeta,
        method: str,
        path: str,
        *,
        limit: int,
        build: Callable[[], dict[str, Any]] | None = None,
    ) -> Any:
        """One authorised call with retry; returns the parsed JSON body (at most ``limit``).

        A POST creates a billed provider job, so it is retried only when the request surely did
        not create one: connection failures, 429 and 503."""
        post = method == "POST"
        what = f"Speechmatics {method} {path.split('?', 1)[0]}"
        for attempt in range(1, MAX_ATTEMPTS + 1):
            last = attempt == MAX_ATTEMPTS
            extra = build() if build else {}
            try:
                async with self._http.stream(
                    method, self._base + path,
                    headers={"Authorization": f"Bearer {key.key}"}, **extra,
                ) as resp:  # fmt: skip
                    status = resp.status_code
                    retryable = status in (429, 503) if post else status == 429 or status >= 500
                    if retryable:
                        if last:
                            raise TransientError(f"{what}: HTTP {status} after retries")
                        await self._sleep(backoff_s(attempt))
                        continue
                    if status == 401:
                        self._keys.mark_invalid(key)
                        log.warning("Speechmatics key rejected (401): disabled until reload")
                        raise SpeechmaticsKeyRejected(f"{what}: HTTP 401")
                    if status >= 500:
                        raise TransientError(f"{what}: HTTP {status}")
                    if status >= 400:
                        raise PipelineError(PROVIDER_REJECTED, detail=f"{what}: HTTP {status}")
                    body = bytearray()
                    async for chunk in resp.aiter_bytes():
                        body += chunk
                        if len(body) > limit:
                            raise PipelineError(
                                PROVIDER_REJECTED, detail=f"{what}: response over {limit} bytes"
                            )
            except httpx2.TransportError as exc:
                if post and not isinstance(exc, httpx2.ConnectError | httpx2.ConnectTimeout):
                    raise TransientError(f"{what}: {type(exc).__name__}") from None
                if last:
                    raise TransientError(f"{what}: {type(exc).__name__} after retries") from None
                await self._sleep(backoff_s(attempt))
                continue
            try:
                return json.loads(body)
            except ValueError:
                raise TransientError(f"{what}: response is not JSON") from None
        raise AssertionError("unreachable")  # pragma: no cover

    # --- Transcriber ------------------------------------------------------------------------------

    async def submit(
        self, audio: Path, *, language: str | None, speaker_count: int | None
    ) -> Submission:
        key = await self._acquire()
        ref = key_ref(key)
        config = json.dumps(build_job_config(speaker_count, language))

        def build() -> dict[str, Any]:  # a fresh file handle per attempt
            fh = audio.open("rb")
            opened.append(fh)
            return {
                "files": {"data_file": (f"audio{audio.suffix}", fh, mime_type(audio))},
                "data": {"config": config},
            }

        opened: list[Any] = []
        try:
            body = await self._request(
                key, "POST", "/v2/jobs", limit=_MAX_STATUS_BYTES, build=build
            )
            job_id = safe_job_id(body.get("id") if isinstance(body, dict) else None)
            if job_id is None:
                raise TransientError("Speechmatics POST /v2/jobs: no job id in the response")
            self._jobs[job_id] = ref
            log.info("speechmatics job created")
            return Submission(job_id, ref)
        finally:
            for fh in opened:
                fh.close()
            self._unpend(ref)

    async def status(self, sub: Submission) -> tuple[str, list[Any]]:
        key = await self._key_for(sub)
        body = await self._request(key, "GET", f"/v2/jobs/{sub.job_id}", limit=_MAX_STATUS_BYTES)
        return parse_job_status(body)

    async def transcript(self, sub: Submission) -> Any:
        key = await self._key_for(sub)
        return await self._request(
            key, "GET", f"/v2/jobs/{sub.job_id}/transcript?format=json-v2",
            limit=MAX_TRANSCRIPT_BYTES,
        )  # fmt: skip
