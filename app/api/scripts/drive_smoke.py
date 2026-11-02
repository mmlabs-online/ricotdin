"""End-to-end check of Google Drive storage against the real account (ARC-17 done check).

    cd app/api
    uv run --env-file .env python -m scripts.drive_smoke

Uploads a 300 KiB test file through a resumable session into the connected root folder,
range-reads bytes 1000-1999 through ``GET /media`` (in-process app, real Drive), deletes it twice
(permanent, idempotent) and prints ``check()``. Needs ``DATABASE_URL_SERVICE`` and
``KEY_ENCRYPTION_SECRET`` (plus the other DATABASE_URL_* the app starts with) and a
``drive_config`` row (``scripts.connect_gdrive``). Prints no secrets, tokens or URLs.
"""

import os
import sys
import tempfile
import uuid
from pathlib import Path

import anyio
import httpx2

from app.core.settings import get_settings
from app.db.session import Database
from app.main import create_app
from app.services.platform import Platform

SIZE = 300 * 1024


async def run() -> int:
    settings = get_settings()
    db = await Database.start(settings)
    platform = Platform.from_settings(settings)
    key = f"smoke/{uuid.uuid4()}.webm"
    data = os.urandom(SIZE)
    failures: list[str] = []
    uploaded = False
    try:
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "smoke.webm"
            src.write_bytes(data)
            async with db.role_transaction("ricotdin_service") as conn:
                storage = await platform.storage(conn)
                obj = await storage.upload_file(key, src, "audio/webm", max_bytes=SIZE)
                url = storage.media_url(key, ttl=120)
        uploaded = True
        print(f"upload: ok ({obj.size_bytes} bytes, md5 verified)")

        app = create_app(settings)
        app.state.db = db
        app.state.platform = platform
        transport = httpx2.ASGITransport(app=app)
        async with httpx2.AsyncClient(transport=transport, base_url="http://api") as client:
            resp = await client.get(url, headers={"Range": "bytes=1000-1999"})
        ok = (
            resp.status_code == 206
            and resp.content == data[1000:2000]
            and resp.headers.get("content-range") == f"bytes 1000-1999/{SIZE}"
        )
        print(f"range read via /media: {'ok' if ok else f'FAILED (HTTP {resp.status_code})'}")
        if not ok:
            failures.append("range")

        async with db.role_transaction("ricotdin_service") as conn:
            storage = await platform.storage(conn)
            await storage.delete(key)
            await storage.delete(key)  # second call is a no-op
            uploaded = False
            gone = await storage.client.get_file(obj.file_id) is None
            unmapped = await storage.stat(key) is None
            health = await storage.check()
        print(f"delete (permanent, idempotent): {'ok' if gone and unmapped else 'FAILED'}")
        if not (gone and unmapped):
            failures.append("delete")
        quota = (
            f", {health.quota_used} of {health.quota_limit} bytes used"
            if health.quota_limit
            else ""
        )
        print(f"check: {'ok' if health.ok else health.problem} ({health.account_email}{quota})")
        if not health.ok:
            failures.append("check")
    finally:
        if uploaded:  # a failed step must not leave the test file in Drive
            async with db.role_transaction("ricotdin_service") as conn:
                await (await platform.storage(conn)).delete(key)
        await platform.aclose()
        await db.close()
    print("PASS" if not failures else f"FAIL: {', '.join(failures)}")
    return 0 if not failures else 1


def main() -> int:
    return anyio.run(run)


if __name__ == "__main__":
    sys.exit(main())
