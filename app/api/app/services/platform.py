"""Platform services bundle (ARC-06), built once per app and stored on ``app.state.platform``.

Routes, the worker and schedulers (ARC-07..10) use it inside a ``ricotdin_service`` or
``ricotdin_worker`` transaction::

    async with db.role_transaction("ricotdin_worker") as conn:
        keys = await platform.keys.active_keys(conn, "gemini")
        storage = await platform.r2(conn)
"""

import os
from collections.abc import Mapping
from dataclasses import dataclass, field

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.settings import Settings
from app.services.config import AppConfigReader
from app.services.crypto import parse_master_key
from app.services.keys.source import KeySource
from app.services.storage.config import StorageConfigSource
from app.services.storage.r2 import R2Storage, StorageNotConfigured


@dataclass
class Platform:
    keys: KeySource
    config: AppConfigReader
    storage_config: StorageConfigSource
    _r2: R2Storage | None = field(default=None, repr=False)

    @classmethod
    def from_settings(cls, settings: Settings, env: Mapping[str, str] | None = None) -> "Platform":
        raw = settings.key_encryption_secret
        master = parse_master_key(raw.get_secret_value()) if raw else None  # bad value: no start
        return cls(
            keys=KeySource(master, dict(os.environ if env is None else env)),
            config=AppConfigReader(),
            storage_config=StorageConfigSource(master),
        )

    async def r2(self, conn: AsyncConnection) -> R2Storage:
        """The bucket from the active storage_config; rebuilt when the config changes."""
        cfg = await self.storage_config.r2(conn)
        if cfg is None:
            raise StorageNotConfigured(detail="no active, decryptable storage_config row for r2")
        if self._r2 is None or self._r2.config != cfg:
            self._r2 = R2Storage(cfg)
        return self._r2


def get_platform(request: Request) -> Platform:
    platform: Platform = request.app.state.platform
    return platform
