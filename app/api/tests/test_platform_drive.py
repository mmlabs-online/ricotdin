"""ARC-17 review: Platform.storage() never closes the shared Drive client under live streams."""

from typing import Any

import anyio
import pytest

from app.services.platform import Platform
from app.services.storage.base import StorageNotConfigured
from app.services.storage.config import DriveConfig, DriveConfigSource, StorageConfigSource
from app.services.storage.media_token import MediaTokenSigner, derive_media_key

MASTER = bytes(range(32))
CFG = DriveConfig("cid", "s", "1//r", "root-folder-0001", "o@example.com")


class Source(DriveConfigSource):
    def __init__(self) -> None:
        super().__init__(MASTER)
        self.value: DriveConfig | None = CFG

    async def get(self, conn: Any) -> DriveConfig | None:
        return self.value


def platform() -> tuple[Platform, Source]:
    src = Source()
    p = Platform(
        keys=None,  # type: ignore[arg-type]
        config=None,  # type: ignore[arg-type]
        storage_config=StorageConfigSource(MASTER),
        drive_config=src,
        media_signer=MediaTokenSigner(derive_media_key(MASTER)),
    )
    return p, src


def test_lookup_failure_raises_without_closing_the_client() -> None:
    p, src = platform()

    async def go() -> None:
        first = (await p.storage(None)).client  # type: ignore[arg-type]
        src.value = None
        with pytest.raises(StorageNotConfigured):
            await p.storage(None)  # type: ignore[arg-type]
        assert not first._http.is_closed
        src.value = CFG
        assert (await p.storage(None)).client is first  # type: ignore[arg-type]
        await p.aclose()
        assert first._http.is_closed

    anyio.run(go)


def test_reconnect_retires_the_old_client_and_closes_it_at_shutdown() -> None:
    p, src = platform()

    async def go() -> None:
        first = (await p.storage(None)).client  # type: ignore[arg-type]
        src.value = DriveConfig("cid", "s", "1//new", "root-folder-0001", "o@example.com")
        second = (await p.storage(None)).client  # type: ignore[arg-type]
        assert second is not first and not first._http.is_closed
        await p.aclose()
        assert first._http.is_closed and second._http.is_closed

    anyio.run(go)


def test_concurrent_rebuild_creates_one_client() -> None:
    p, _ = platform()

    async def go() -> set[int]:
        ids: set[int] = set()

        async def one() -> None:
            ids.add(id((await p.storage(None)).client))  # type: ignore[arg-type]

        async with anyio.create_task_group() as tg:
            for _ in range(10):
                tg.start_soon(one)
        await p.aclose()
        return ids

    assert len(anyio.run(go)) == 1
