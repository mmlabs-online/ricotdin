"""R2 credentials from ``storage_config`` (ARC-06; port of v1 ``lib/storage/config.ts``).

The newest active ``provider='r2'`` row, its secret decrypted with KEY_ENCRYPTION_SECRET, cached
30 s. There is no env-var fallback (v1 rule: R2 is configured in the admin UI only). Unreadable
or undecryptable configuration resolves to None; callers raise ``StorageNotConfigured``.
"""

import re
from collections.abc import Callable, Mapping
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

_ACCOUNT_ID = re.compile(r"[0-9a-f]{32}")
_BUCKET = re.compile(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]")

STORAGE_SAFE_FIELDS = (
    "id",
    "created_at",
    "updated_at",
    "provider",
    "label",
    "account_id",
    "access_key_id",
    "bucket",
    "secret_last4",
    "status",
    "disabled_reason",
    "last_used_at",
)


@dataclass(frozen=True)
class R2Config:
    account_id: str
    access_key_id: str
    secret_access_key: str = field(repr=False)
    bucket: str

    def __post_init__(self) -> None:
        # The endpoint host is built from account_id: anything else could point signed requests
        # (and audio) at another host (SSRF).
        if not _ACCOUNT_ID.fullmatch(self.account_id):
            raise ValueError("R2 account id must be 32 lowercase hex characters")
        if not _BUCKET.fullmatch(self.bucket) or ".." in self.bucket:
            raise ValueError("R2 bucket name must be 3-63 lowercase letters, digits, '-' or '.'")

    @property
    def endpoint(self) -> str:
        return f"https://{self.account_id}.r2.cloudflarestorage.com"


def mask_storage_row(row: Mapping[str, Any]) -> dict[str, Any]:
    return {name: row.get(name) for name in STORAGE_SAFE_FIELDS}


class StorageConfigSource:
    def __init__(
        self, master_key: bytes | None, *, clock: Callable[[], float] | None = None
    ) -> None:
        self._master = master_key
        self._cache: TtlCache[str, R2Config | None] = (
            TtlCache(CACHE_TTL_S, clock) if clock else TtlCache(CACHE_TTL_S)
        )
        self._failed: TtlCache[str, bool] = (
            TtlCache(FAILURE_TTL_S, clock) if clock else TtlCache(FAILURE_TTL_S)
        )

    def __repr__(self) -> str:
        return "StorageConfigSource()"

    def invalidate(self) -> None:
        self._cache.invalidate()
        self._failed.invalidate()

    async def r2(self, conn: AsyncConnection) -> R2Config | None:
        hit, cached = self._cache.get("r2")
        if hit:
            return cached
        if self._failed.get("r2")[0]:
            return None
        try:
            async with conn.begin_nested():  # a failed read must not abort the caller's tx
                resolved = await self._load(conn)
        except Exception as exc:  # noqa: BLE001 - v1: unreadable config resolves to null
            log.error("storage_config lookup failed (%s)", type(exc).__name__)
            self._failed.put("r2", True)
            return None
        self._cache.put("r2", resolved)
        return resolved

    async def _load(self, conn: AsyncConnection) -> R2Config | None:
        row = (
            await conn.execute(
                text(
                    "SELECT id, account_id, access_key_id, bucket, secret_ciphertext, secret_iv, "
                    "secret_auth_tag FROM storage_config "
                    "WHERE provider = 'r2' AND status = 'active' "
                    "ORDER BY created_at DESC LIMIT 1"
                )
            )
        ).first()
        if row is None:
            return None
        if self._master is None:
            log.error("KEY_ENCRYPTION_SECRET is not set: R2 storage config is unusable")
            return None
        try:
            secret = decrypt_with_key(
                EncryptedSecret(row.secret_ciphertext, row.secret_iv, row.secret_auth_tag),
                self._master,
            )
        except DecryptError:
            log.error("storage_config row %s does not decrypt", row.id)
            return None
        try:
            return R2Config(row.account_id, row.access_key_id, secret, row.bucket)
        except ValueError as exc:
            log.error("storage_config row %s is invalid: %s", row.id, exc)
            return None
