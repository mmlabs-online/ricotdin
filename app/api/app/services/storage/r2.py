"""Cloudflare R2 object storage (ARC-06; port of v1 ``lib/storage/index.ts``). Server-only.

boto3 is synchronous: presigning is local computation (no network), every other call runs in a
worker thread. The client is rebuilt only when the resolved credentials change. Legacy rows with
``storage_provider = 'supabase'`` are not served by v2 — ARC-03 copies those objects to R2 — so
they raise ``LegacyStorageUnsupported``.

Callers must pass keys that passed ``app.services.storage.ownership`` first. The browser PUT must
send exactly the ``Content-Type`` used to presign (R2 answers 403 otherwise).
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import anyio
import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from app.core.errors import ServiceUnavailable
from app.services.storage.config import R2Config

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client
else:
    S3Client = Any

MAX_PRESIGN_S = 7 * 24 * 3600  # SigV4 limit
UPLOAD_URL_TTL_S = 900
DOWNLOAD_URL_TTL_S = 3600


class StorageNotConfigured(ServiceUnavailable):
    code = "storage_not_configured"
    message = "Storage is not configured yet. Please contact an administrator."


class LegacyStorageUnsupported(ServiceUnavailable):
    code = "legacy_storage"
    message = "This recording is not available yet. Please try again later."


class StorageError(ServiceUnavailable):
    code = "storage_error"
    message = "The recording storage is temporarily unavailable. Please try again later."


def r2_client(cfg: R2Config) -> S3Client:
    client: S3Client = boto3.client(
        "s3",
        endpoint_url=cfg.endpoint,
        aws_access_key_id=cfg.access_key_id,
        aws_secret_access_key=cfg.secret_access_key,
        region_name="auto",
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            connect_timeout=10,
            read_timeout=60,
            retries={"max_attempts": 3, "mode": "standard"},
        ),
    )
    return client


def _check_ttl(expires_in: int) -> None:
    if not 1 <= expires_in <= MAX_PRESIGN_S:
        raise ValueError(f"expires_in must be 1..{MAX_PRESIGN_S} seconds")


def presign_put(
    client: S3Client,
    bucket: str,
    key: str,
    *,
    content_type: str,
    expires_in: int = UPLOAD_URL_TTL_S,
) -> str:
    _check_ttl(expires_in)
    return client.generate_presigned_url(
        "put_object",
        Params={"Bucket": bucket, "Key": key, "ContentType": content_type},
        ExpiresIn=expires_in,
    )


def presign_get(
    client: S3Client, bucket: str, key: str, *, expires_in: int = DOWNLOAD_URL_TTL_S
) -> str:
    _check_ttl(expires_in)
    return client.generate_presigned_url(
        "get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=expires_in
    )


def _require_r2(provider: str) -> None:
    if provider != "r2":
        raise LegacyStorageUnsupported(detail=f"storage_provider={provider!r} is not served by v2")


@dataclass
class R2Storage:
    """Operations on the configured bucket. Build with ``R2Storage(config)``."""

    config: R2Config
    _client: S3Client | None = field(default=None, repr=False)

    @property
    def client(self) -> S3Client:
        if self._client is None:
            self._client = r2_client(self.config)
        return self._client

    def upload_url(self, key: str, content_type: str, expires_in: int = UPLOAD_URL_TTL_S) -> str:
        return presign_put(self.client, self.config.bucket, key, content_type=content_type,
                           expires_in=expires_in)  # fmt: skip

    def download_url(self, key: str, provider: str, expires_in: int = DOWNLOAD_URL_TTL_S) -> str:
        _require_r2(provider)
        return presign_get(self.client, self.config.bucket, key, expires_in=expires_in)

    async def upload_bytes(self, key: str, data: bytes, content_type: str) -> None:
        await self._run(
            lambda: self.client.put_object(
                Bucket=self.config.bucket, Key=key, Body=data, ContentType=content_type
            )
        )

    async def get_bytes(self, key: str, provider: str) -> bytes:
        _require_r2(provider)

        def read() -> bytes:
            body = self.client.get_object(Bucket=self.config.bucket, Key=key)["Body"]
            try:
                return body.read()
            finally:
                body.close()

        result: bytes = await self._run(read)
        return result

    async def size(self, key: str, provider: str) -> int | None:
        """Object size in bytes, or None when it does not exist."""
        _require_r2(provider)

        def head() -> int | None:
            try:
                return int(
                    self.client.head_object(Bucket=self.config.bucket, Key=key)["ContentLength"]
                )
            except ClientError as exc:
                if exc.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                    return None
                raise

        result: int | None = await self._run(head)
        return result

    async def delete(self, key: str, provider: str) -> None:
        _require_r2(provider)
        await self._run(lambda: self.client.delete_object(Bucket=self.config.bucket, Key=key))

    async def delete_many(self, items: list[tuple[str, str]]) -> list[str]:
        """Delete (key, provider) pairs; returns the keys that failed. Never raises."""
        failed: list[str] = []
        for key, provider in items:
            try:
                await self.delete(key, provider)
            except Exception:  # noqa: BLE001 - reported to the caller as a warning
                failed.append(key)
        return failed

    async def check(self) -> bool:
        """HeadBucket with these credentials (admin "test connection"). Never raises."""
        try:
            await self._run(lambda: self.client.head_bucket(Bucket=self.config.bucket))
        except StorageError:
            return False
        return True

    async def _run[T](self, fn: Callable[[], T]) -> T:
        try:
            return await anyio.to_thread.run_sync(fn)
        except (ClientError, BotoCoreError) as exc:
            # Error code only: botocore messages can echo request details.
            code = (
                exc.response.get("Error", {}).get("Code") if isinstance(exc, ClientError) else None
            )
            raise StorageError(detail=f"{type(exc).__name__} {code or ''}".strip()) from None
