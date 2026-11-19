"""Storage credentials: Google Drive from ``drive_config`` (ARC-17). (The v1 R2 reader of
``storage_config`` was removed in ARC-16; the table stays in the schema.)
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.logging import get_logger
from app.services.cache import TtlCache
from app.services.crypto import DecryptError, EncryptedSecret, decrypt_with_key

log = get_logger("storage")
FAILURE_TTL_S = 5.0  # after a failed lookup, retry the database soon
CACHE_TTL_S = 30.0

# --- Google Drive (ARC-17) ---------------------------------------------------------------------


@dataclass(frozen=True)
class DriveConfig:
    """The single ``drive_config`` row, secrets decrypted. Written by ``scripts.connect_gdrive``."""

    client_id: str
    client_secret: str = field(repr=False)
    refresh_token: str = field(repr=False)
    root_folder_id: str
    account_email: str


class DriveConfigSource:
    """``drive_config`` with its secrets decrypted, cached 30 s (5 s after a failed lookup).
    Missing, unreadable or undecryptable configuration resolves to None."""

    def __init__(
        self, master_key: bytes | None, *, clock: Callable[[], float] | None = None
    ) -> None:
        self._master = master_key
        self._cache: TtlCache[str, DriveConfig | None] = (
            TtlCache(CACHE_TTL_S, clock) if clock else TtlCache(CACHE_TTL_S)
        )
        self._failed: TtlCache[str, bool] = (
            TtlCache(FAILURE_TTL_S, clock) if clock else TtlCache(FAILURE_TTL_S)
        )

    def __repr__(self) -> str:
        return "DriveConfigSource()"

    def invalidate(self) -> None:
        self._cache.invalidate()
        self._failed.invalidate()

    async def get(self, conn: AsyncConnection) -> DriveConfig | None:
        hit, cached = self._cache.get("drive")
        if hit:
            return cached
        if self._failed.get("drive")[0]:
            return None
        try:
            async with conn.begin_nested():  # a failed read must not abort the caller's tx
                row = (
                    await conn.execute(
                        text(
                            "SELECT client_id, client_secret_ciphertext, client_secret_iv, "
                            "client_secret_auth_tag, refresh_token_ciphertext, refresh_token_iv, "
                            "refresh_token_auth_tag, root_folder_id, account_email "
                            "FROM drive_config WHERE id"
                        )
                    )
                ).first()
        except Exception as exc:  # noqa: BLE001 - unreadable config resolves to None
            log.error("drive_config lookup failed (%s)", type(exc).__name__)
            self._failed.put("drive", True)
            return None
        resolved = self._decrypt(row)
        self._cache.put("drive", resolved)
        return resolved

    def _decrypt(self, row: Any) -> DriveConfig | None:
        if row is None:
            return None
        if self._master is None:
            log.error("KEY_ENCRYPTION_SECRET is not set: Google Drive config is unusable")
            return None
        try:
            secret = decrypt_with_key(
                EncryptedSecret(
                    row.client_secret_ciphertext, row.client_secret_iv, row.client_secret_auth_tag
                ),
                self._master,
            )
            refresh = decrypt_with_key(
                EncryptedSecret(
                    row.refresh_token_ciphertext, row.refresh_token_iv, row.refresh_token_auth_tag
                ),
                self._master,
            )
        except DecryptError:
            log.error("drive_config does not decrypt (different KEY_ENCRYPTION_SECRET?)")
            return None
        return DriveConfig(row.client_id, secret, refresh, row.root_folder_id, row.account_email)
