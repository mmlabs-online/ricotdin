"""ARC-17: GET /media — token check before any DB/Drive call, Range → 206, stream cap, headers."""

import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import anyio
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.settings import Settings
from app.db.session import get_database
from app.main import create_app
from app.services.platform import Platform
from app.services.storage.base import StoredObject
from app.services.storage.config import DriveConfigSource, StorageConfigSource
from app.services.storage.gdrive import DriveClient, DriveStorage, MemoryObjectMap
from app.services.storage.media_token import MediaTokenSigner, derive_media_key
from tests.fake_drive import CONFIG, FakeDrive

MASTER = bytes(range(32))
SIGNER = MediaTokenSigner(derive_media_key(MASTER))
KEY = "u1/m1.webm"
DATA = bytes(range(256)) * 20  # 5120 bytes


async def _no_sleep(_: float) -> None:
    return None


class FakeDb:
    def __init__(self) -> None:
        self.transactions = 0

    @asynccontextmanager
    async def role_transaction(self, group: str) -> AsyncIterator[Any]:
        assert group == "ricotdin_service"
        self.transactions += 1
        yield None


class FakePlatform(Platform):
    objects: MemoryObjectMap
    drive: FakeDrive

    async def storage(self, conn: AsyncConnection) -> DriveStorage:
        if self._drive is None:
            self._drive = DriveClient(CONFIG, transport=self.drive.transport(), sleep=_no_sleep)
        assert self.media_signer is not None
        return DriveStorage(self._drive, self.objects, self.media_signer)


@pytest.fixture
def env() -> Any:
    drive = FakeDrive()
    fid = drive.add_file(DATA, key=KEY)
    platform = FakePlatform(
        keys=None,  # type: ignore[arg-type]
        config=None,  # type: ignore[arg-type]
        storage_config=StorageConfigSource(MASTER),
        drive_config=DriveConfigSource(MASTER),
        media_signer=SIGNER,
    )
    platform.drive = drive
    platform.objects = MemoryObjectMap()
    anyio.run(platform.objects.put, StoredObject(KEY, fid, len(DATA), "audio/webm", None))
    app = create_app(Settings.model_validate({}))
    app.state.platform = platform
    db = FakeDb()
    app.dependency_overrides[get_database] = lambda: db
    return {"client": TestClient(app), "drive": drive, "db": db, "platform": platform}


def token(key: str = KEY, ttl: int = 600) -> str:
    return SIGNER.sign(key, now=time.time(), ttl=ttl)


def test_range_request_returns_206_with_exact_bytes(env: Any) -> None:
    r = env["client"].get(f"/media?t={token()}", headers={"Range": "bytes=1000-1999"})
    assert r.status_code == 206
    assert r.headers["content-range"] == f"bytes 1000-1999/{len(DATA)}"
    assert r.headers["content-length"] == "1000"
    assert r.headers["accept-ranges"] == "bytes"
    assert r.headers["content-type"] == "audio/webm"
    assert r.headers["cache-control"] == "private, max-age=0"
    assert r.content == DATA[1000:2000]
    assert env["platform"].media_slots.in_use == 0


def test_full_request_returns_200(env: Any) -> None:
    r = env["client"].get(f"/media?t={token()}")
    assert r.status_code == 200 and r.content == DATA
    assert r.headers["content-length"] == str(len(DATA))


@pytest.mark.parametrize("bad", ["expired", "tampered", "other-key-signer", "garbage"])
def test_bad_token_is_403_without_db_or_drive(env: Any, bad: str) -> None:
    t = {
        "expired": SIGNER.sign(KEY, now=time.time() - 1000, ttl=60),
        "tampered": token()[:-2] + "AA",
        "other-key-signer": MediaTokenSigner(derive_media_key(bytes(32))).sign(
            KEY, now=time.time(), ttl=60
        ),
        "garbage": "x",
    }[bad]
    r = env["client"].get(f"/media?t={t}")
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "invalid_media_token"
    assert env["db"].transactions == 0 and env["drive"].requests == []


def test_unknown_key_is_404(env: Any) -> None:
    r = env["client"].get(f"/media?t={token('u1/other.webm')}")
    assert r.status_code == 404
    assert env["platform"].media_slots.in_use == 0


def test_range_past_the_end_is_416(env: Any) -> None:
    r = env["client"].get(f"/media?t={token()}", headers={"Range": "bytes=999999-"})
    assert r.status_code == 416
    assert env["platform"].media_slots.in_use == 0


def test_busy_server_answers_503(env: Any) -> None:
    slots = env["platform"].media_slots
    for _ in range(slots.limit):
        assert slots.try_acquire()
    r = env["client"].get(f"/media?t={token()}")
    assert r.status_code == 503 and r.json()["error"]["code"] == "media_busy"
    assert env["drive"].requests == []


def test_drive_failure_releases_the_slot(env: Any) -> None:
    env["drive"].fail = [500] * 5
    r = env["client"].get(f"/media?t={token()}")
    assert r.status_code == 503
    assert env["platform"].media_slots.in_use == 0


def test_missing_token_is_422(env: Any) -> None:
    assert env["client"].get("/media").status_code == 422
