"""Platform services bundle (ARC-06), built once per app and stored on ``app.state.platform``.

Routes, the worker and schedulers (ARC-07..10) use it inside a ``ricotdin_service`` or
``ricotdin_worker`` transaction::

    async with db.role_transaction("ricotdin_worker") as conn:
        keys = await platform.keys.active_keys(conn, "gemini")
        storage = await platform.storage(conn)  # Google Drive (ARC-17)

Key pools (``KeyPool`` / ``SpeechmaticsKeyPool``) keep cooldowns and in-flight counts per
instance: callers (ARC-08) must keep one pool per provider and rebuild it only when
``keys.active_keys`` returns a different key set, never one pool per request.
"""

import os
from collections.abc import Mapping
from dataclasses import dataclass, field

import httpx2
from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.settings import Settings
from app.services.config import AppConfigReader
from app.services.crypto import parse_master_key
from app.services.keys.source import KeySource
from app.services.storage.base import StorageNotConfigured
from app.services.storage.config import DriveConfigSource, StorageConfigSource
from app.services.storage.drive_rules import StreamSlots
from app.services.storage.gdrive import DriveClient, DriveStorage, SqlObjectMap
from app.services.storage.media_token import MediaTokenSigner, derive_media_key
from app.services.storage.r2 import R2Storage

MEDIA_STREAMS = 8  # concurrent /media streams per process


@dataclass
class Platform:
    keys: KeySource
    config: AppConfigReader
    storage_config: StorageConfigSource
    drive_config: DriveConfigSource
    media_signer: MediaTokenSigner | None = field(default=None, repr=False)
    web_origin: str | None = None
    media_slots: StreamSlots = field(default_factory=lambda: StreamSlots(MEDIA_STREAMS))
    drive_transport: httpx2.AsyncBaseTransport | None = field(default=None, repr=False)
    _r2: R2Storage | None = field(default=None, repr=False)
    _drive: DriveClient | None = field(default=None, repr=False)

    @classmethod
    def from_settings(cls, settings: Settings, env: Mapping[str, str] | None = None) -> "Platform":
        raw = settings.key_encryption_secret
        master = parse_master_key(raw.get_secret_value()) if raw else None  # bad value: no start
        return cls(
            keys=KeySource(master, dict(os.environ if env is None else env)),
            config=AppConfigReader(),
            storage_config=StorageConfigSource(master),
            drive_config=DriveConfigSource(master),
            media_signer=MediaTokenSigner(derive_media_key(master)) if master else None,
            web_origin=settings.web_origin,
        )

    async def storage(self, conn: AsyncConnection) -> DriveStorage:
        """Google Drive storage bound to ``conn`` for the key → file id map (ARC-17). The Drive
        client (HTTP pool + cached access token) is shared and rebuilt when the config changes."""
        cfg = await self.drive_config.get(conn)
        if cfg is None or self.media_signer is None:
            await self._close_drive()  # drop the client: it holds the old secrets
            raise StorageNotConfigured(
                detail="no decryptable drive_config row: run `python -m scripts.connect_gdrive`"
            )
        if self._drive is None or self._drive.config != cfg:
            await self._close_drive()
            self._drive = DriveClient(cfg, transport=self.drive_transport)
        return DriveStorage(self._drive, SqlObjectMap(conn), self.media_signer, self.web_origin)

    async def _close_drive(self) -> None:
        if self._drive is not None:
            old, self._drive = self._drive, None
            await old.aclose()

    async def aclose(self) -> None:
        await self._close_drive()

    async def r2(self, conn: AsyncConnection) -> R2Storage:
        """The v1 bucket from the active storage_config (ARC-18 source reader only; v2 stores
        files in Google Drive via ``storage``). Rebuilt when the config changes."""
        cfg = await self.storage_config.r2(conn)
        if cfg is None:
            self._r2 = None  # drop the client: it holds the old secret
            raise StorageNotConfigured(detail="no active, decryptable storage_config row for r2")
        if self._r2 is None or self._r2.config != cfg:
            self._r2 = R2Storage(cfg)
        return self._r2


def get_platform(request: Request) -> Platform:
    platform: Platform = request.app.state.platform
    return platform
