"""Test-only API for the web end-to-end suite (ARC-13c, `app/web/e2e`). Never a deployment target:
it lives in tests/, which the API image does not contain.

It runs the real FastAPI app on a scratch database (`ricotdin_test_*` on the `DATABASE_URL`
server, dropped on exit) with three stand-ins, so the core flow runs without Google or AI keys:

- storage: uploads are accepted in memory (the browser's PUT to Drive is intercepted by
  Playwright) and `/media` serves a generated silent WAV;
- AI: embeddings and answers are canned; chat answers cite the retrieved chunks;
- worker: a queued job turns its meeting `done` with a fixed transcript, notes, to-do and event.

Run from app/api: `uv run python -m tests.e2e_server` (env: DATABASE_URL, optional
E2E_WEB_ORIGIN = the web origin, default http://localhost:4173, and E2E_PORT, default 8000).
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import re
import secrets
import signal
import uuid
import wave
from collections.abc import Callable
from pathlib import Path
from typing import Any

import psycopg
import uvicorn
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route

from app.auth.jwt import generate_private_pem
from app.auth.passwords import hash_password
from app.core.settings import Settings
from app.db.provision import drop_login, ensure_login
from app.db.scratch import admin_url, scratch_database
from app.main import create_app
from app.services.storage.base import StorageHealth, StoredObject
from tests.conftest import alembic_upgrade

PASSWORD = "correct horse battery"  # noqa: S105 - the test account of a scratch database
USERS = (("e2e@example.com", "e2e_user"),)
DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id="
VECTOR = "[" + ",".join(["0.036"] * 768) + "]"
SEGMENTS = (
    ("Alex", 0, "Welcome everyone, let us start with the beta scope."),
    ("Alex", 6000, "We keep the beta limited to thirty design partners."),
    ("Maya", 15000, "I will finalize the onboarding copy before June seventh."),
    ("Sam", 31000, "I will send the final partner list around for approval."),
)


def silent_wav(seconds: int = 60) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(1)
        w.setframerate(8000)
        w.writeframes(b"\x80" * 8000 * seconds)
    return buf.getvalue()


class FakeStorage:
    """The `Storage` calls the API makes during the core flow, kept in memory."""

    def __init__(self) -> None:
        self.objects: dict[str, StoredObject] = {}

    async def upload_session(
        self, key: str, content_type: str, content_length: int, *, max_bytes: int
    ) -> str:
        return DRIVE_UPLOAD + secrets.token_hex(8)

    async def confirm_upload(
        self, key: str, file_id: str, *, content_type: str, content_length: int, max_bytes: int
    ) -> StoredObject:
        obj = StoredObject(key, file_id, content_length, content_type, None)
        self.objects[key] = obj
        return obj

    def media_url(self, key: str, *, ttl: int = 900) -> str:
        return "/media?t=e2e"

    async def stat(self, key: str) -> StoredObject | None:
        return self.objects.get(key)

    async def size(self, key: str) -> int | None:
        obj = self.objects.get(key)
        return obj.size_bytes if obj else None

    async def get_bytes(self, key: str, *, max_bytes: int) -> bytes:
        return b""

    async def download_to_file(self, key: str, target: Path, *, max_bytes: int) -> int:
        return 0

    async def delete(self, key: str) -> None:
        self.objects.pop(key, None)

    async def delete_many(self, keys: list[str]) -> list[str]:
        for key in keys:
            self.objects.pop(key, None)
        return []

    async def check(self) -> StorageHealth:
        return StorageHealth(ok=True)


class FakeAI:
    """Canned answers in the shapes the real `AIService` returns."""

    async def embed(self, db: Any, group: str, texts: list[str], **_: Any) -> list[list[float]]:
        return [[0.036] * 768 for _ in texts]

    async def generate_json(
        self, db: Any, group: str, provider: str, model: str, *, user: str,
        parse: Callable[[str], Any], **_: Any,
    ) -> Any:  # fmt: skip
        chunk_ids = re.findall(r'chunk_id="([^"]+)"', user)
        if chunk_ids:  # chat
            answer = "The beta stays limited to **thirty design partners**."
            return parse(json.dumps({"answer": answer, "citations": [{"chunk_id": chunk_ids[0]}]}))
        analysis = {"summary": "Regenerated summary.", "notes_markdown": "## Notes\n- regenerated",
                    "todos": [], "calendar_suggestions": []}  # fmt: skip
        return parse(json.dumps(analysis))

    async def aclose(self) -> None:
        return None


def finish_queued_jobs(url: str) -> None:
    """The stand-in worker: every queued job ends with its meeting `done` and fixed results."""
    with psycopg.connect(url, autocommit=False) as conn:
        rows = conn.execute(
            "SELECT id, meeting_id FROM jobs WHERE status = 'queued' FOR UPDATE SKIP LOCKED"
        ).fetchall()
        for job_id, meeting_id in rows:
            conn.execute("UPDATE jobs SET status = 'done' WHERE id = %s", (job_id,))
            conn.execute(
                "UPDATE meetings SET status = 'done', error_message = NULL, language = 'en', "
                "duration_seconds = 60, summary = %s, notes = %s, generation_provider = 'gemini', "
                "generation_model = 'gemini-2.5-flash' WHERE id = %s",
                (
                    "The team kept the beta to **thirty design partners**.",
                    "## Decisions\n- Beta limited to 30 partners\n\n## Next steps\n- Onboarding",
                    meeting_id,
                ),
            )
            ids = []
            for i, (speaker, start, text) in enumerate(SEGMENTS):
                ids.append(
                    conn.execute(
                        "INSERT INTO transcript_segments (meeting_id, segment_index, speaker, "
                        "start_ms, end_ms, text, confidence) VALUES (%s,%s,%s,%s,%s,%s,0.9) "
                        "RETURNING id",
                        (meeting_id, i, speaker, start, start + 5000, text),
                    ).fetchone()
                )
            for i in range(2):
                pair = SEGMENTS[i * 2 : i * 2 + 2]
                conn.execute(
                    "INSERT INTO transcript_chunks (meeting_id, chunk_index, content, embedding, "
                    "start_ms, end_ms) VALUES (%s,%s,%s,%s::vector,%s,%s)",
                    (meeting_id, i, " ".join(t for _, _, t in pair), VECTOR, pair[0][1],
                     pair[-1][1] + 5000),
                )  # fmt: skip
            source = ids[2][0] if ids[2] else None
            conn.execute(
                "INSERT INTO todos (meeting_id, content, assignee, due_date, status, "
                "source_segment_id) VALUES (%s, 'Finalize onboarding copy', 'Maya', "
                "'2026-12-07', 'open', %s)",
                (meeting_id, source),
            )
            conn.execute(
                "INSERT INTO calendar_suggestions (meeting_id, title, proposed_at, raw_mention) "
                "VALUES (%s, 'Launch readiness review', '2026-12-04T03:00:00Z', 'Friday at ten')",
                (meeting_id,),
            )
        conn.commit()


async def fake_worker(url: str) -> None:
    while True:
        try:
            await asyncio.to_thread(finish_queued_jobs, url)
        except Exception as exc:  # noqa: BLE001 - keep serving; the next poll tries again
            print(f"e2e fake worker: {type(exc).__name__}", flush=True)
        await asyncio.sleep(0.5)


def seed(url: str) -> None:
    with psycopg.connect(url, autocommit=True) as conn:
        for email, username in USERS:
            uid = conn.execute(
                "INSERT INTO users (email, password_hash, role, email_verified_at) "
                "VALUES (%s, %s, 'user', now()) RETURNING id",
                (email, hash_password(PASSWORD)),
            ).fetchone()
            assert uid is not None  # noqa: S101 - test-only script
            conn.execute(
                "INSERT INTO profiles (id, username, role) VALUES (%s, %s, 'user')",
                (uid[0], username),
            )
            conn.execute(
                "SELECT quota_apply_movement(%s, 36000, 50, 'admin_grant', %s, false, NULL, NULL, "
                "'{}'::jsonb)",
                (uid[0], f"e2e:{uuid.uuid4()}"),
            )


def _exit_on_term(signum: int, frame: object) -> None:
    raise SystemExit(0)


def main() -> None:
    web = os.environ.get("E2E_WEB_ORIGIN", "http://localhost:4173")
    port = int(os.environ.get("E2E_PORT", "8000"))
    owner = admin_url()
    suffix = secrets.token_hex(3)
    audio = silent_wav()
    with scratch_database("e2e") as url:
        alembic_upgrade(url)
        api = ensure_login(owner, "ricotdin_app", f"ricotdin_test_api_{suffix}", connection_limit=5)
        svc = ensure_login(
            owner, "ricotdin_service", f"ricotdin_test_svc_{suffix}", connection_limit=5
        )
        try:
            seed(url)
            settings = Settings.model_validate({
                "DATABASE_URL_APP": api.url(url), "DATABASE_URL_SERVICE": svc.url(url),
                "JWT_PRIVATE_KEY": generate_private_pem(), "WEB_ORIGIN": web,
                "ALLOWED_ORIGINS": web, "KEY_ENCRYPTION_SECRET": secrets.token_hex(32),
            })  # fmt: skip
            app = create_app(settings)
            storage = FakeStorage()

            async def fake_storage(conn: Any) -> FakeStorage:
                return storage

            app.state.platform.storage = fake_storage
            app.state.ai = FakeAI()

            async def media(request: Request) -> Response:
                return Response(audio, media_type="audio/wav")

            app.router.routes.insert(0, Route("/media", media))

            async def serve() -> None:
                config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
                worker = asyncio.create_task(fake_worker(url))
                try:
                    await uvicorn.Server(config).serve()
                finally:
                    worker.cancel()

            # uvicorn re-raises the signal it caught once it has stopped: turn SIGTERM into a normal
            # exit so the finally blocks drop the scratch database and the logins
            signal.signal(signal.SIGTERM, _exit_on_term)
            print(f"e2e api on http://127.0.0.1:{port} (web {web})", flush=True)
            asyncio.run(serve())
        finally:
            drop_login(owner, api.name)
            drop_login(owner, svc.name)


if __name__ == "__main__":
    main()
