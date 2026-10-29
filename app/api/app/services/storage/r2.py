"""Cloudflare R2 object storage (ARC-06; port of v1 ``lib/storage/index.ts``). Server-only.

boto3 is synchronous: presigning is local computation (no network); every other call runs in a
worker thread. Each ``R2Storage`` builds its client once, from its own boto3 session (the default
session is not thread-safe; a built client is). Legacy rows with ``storage_provider = 'supabase'``
are not served by v2 — ARC-03 copies those objects to R2 — so they raise
``LegacyStorageUnsupported``.

Callers must pass keys that passed ``app.services.storage.ownership`` first. Upload URLs are only
issued for media types and can bind the exact size; the browser PUT must send exactly the
``Content-Type`` (and ``Content-Length``) used to presign — R2 answers 403 otherwise. Reads are
size-limited: ``get_bytes`` for small objects, ``download_to_file`` for meeting audio.
"""

import os
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

import anyio
import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from app.core.errors import AppError, NotFound, ServiceUnavailable
from app.services.storage.config import R2Config

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client
else:
    S3Client = Any

MAX_PRESIGN_S = 7 * 24 * 3600  # SigV4 limit
UPLOAD_URL_TTL_S = 900
DOWNLOAD_URL_TTL_S = 3600
_CHUNK = 1024 * 1024
# Media only: an uploaded text/html or SVG object would be served back from our bucket.
_UPLOAD_TYPES = re.compile(r"(?:audio|video)/[a-z0-9][a-z0-9.+-]*|image/(?:jpeg|png|webp)")
_MISSING = {"404", "NoSuchKey", "NotFound"}


class UnsupportedContentType(AppError):
    status = 415
    code = "unsupported_content_type"
    message = "This file type cannot be uploaded."


class StorageNotConfigured(ServiceUnavailable):
    code = "storage_not_configured"
    message = "Storage is not configured yet. Please contact an administrator."


class LegacyStorageUnsupported(ServiceUnavailable):
    code = "legacy_storage"
    message = "This recording is not available yet. Please try again later."


class StorageError(ServiceUnavailable):
    code = "storage_error"
    message = "The recording storage is temporarily unavailable. Please try again later."


class StorageObjectNotFound(NotFound):
    code = "object_not_found"
    message = "The file was not found."


class ObjectTooLarge(AppError):
    status = 413
    code = "object_too_large"
    message = "The file is too large."


def r2_client(cfg: R2Config) -> S3Client:
    session = boto3.session.Session()  # own session: the default one is not thread-safe
    client: S3Client = session.client(
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
    content_length: int | None = None,
) -> str:
    """Presigned PUT. With ``content_length`` the signature binds the exact size, so the upload
    cannot be larger than what the server validated (ARC-07 passes the declared size)."""
    _check_ttl(expires_in)
    params: dict[str, Any] = {"Bucket": bucket, "Key": key, "ContentType": content_type}
    if content_length is not None:
        if content_length < 0:
            raise ValueError("content_length must be >= 0")
        params["ContentLength"] = content_length
    return client.generate_presigned_url("put_object", Params=params, ExpiresIn=expires_in)


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


def _error_code(exc: BaseException) -> str | None:
    if isinstance(exc, ClientError):
        code = exc.response.get("Error", {}).get("Code")
        return str(code) if code else None
    return None


@dataclass
class R2Storage:
    """Operations on the configured bucket. Build with ``R2Storage(config)``."""

    config: R2Config
    _client: S3Client | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if self._client is None:
            self._client = r2_client(self.config)

    @property
    def client(self) -> S3Client:
        assert self._client is not None  # noqa: S101 - built in __post_init__
        return self._client

    def upload_url(
        self,
        key: str,
        content_type: str,
        expires_in: int = UPLOAD_URL_TTL_S,
        content_length: int | None = None,
    ) -> str:
        # Parameters (``audio/webm;codecs=opus`` from the recorder) and case are ignored for the
        # check; the URL is still signed with the exact string the browser will send.
        base = content_type.split(";", 1)[0].strip().lower()
        if not _UPLOAD_TYPES.fullmatch(base):
            raise UnsupportedContentType(
                detail="upload content type must be audio/*, video/* or a jpeg/png/webp image"
            )
        return presign_put(
            self.client,
            self.config.bucket,
            key,
            content_type=content_type,
            expires_in=expires_in,
            content_length=content_length,
        )

    def download_url(self, key: str, provider: str, expires_in: int = DOWNLOAD_URL_TTL_S) -> str:
        _require_r2(provider)
        return presign_get(self.client, self.config.bucket, key, expires_in=expires_in)

    async def upload_bytes(self, key: str, data: bytes, content_type: str) -> None:
        await self._run(
            lambda: self.client.put_object(
                Bucket=self.config.bucket, Key=key, Body=data, ContentType=content_type
            )
        )

    def _head_size(self, key: str) -> int | None:
        try:
            return int(self.client.head_object(Bucket=self.config.bucket, Key=key)["ContentLength"])
        except ClientError as exc:
            if _error_code(exc) in _MISSING:
                return None
            raise

    def _open_checked(self, key: str, max_bytes: int) -> tuple[int, Any]:
        size = self._head_size(key)
        if size is None:
            raise StorageObjectNotFound(detail="object does not exist")
        if size > max_bytes:
            raise ObjectTooLarge(detail=f"object is {size} bytes, limit {max_bytes}")
        return size, self.client.get_object(Bucket=self.config.bucket, Key=key)["Body"]

    async def get_bytes(self, key: str, provider: str, *, max_bytes: int) -> bytes:
        """Whole object in memory — only for small objects (avatars, small files)."""
        _require_r2(provider)

        def read() -> bytes:
            _size, body = self._open_checked(key, max_bytes)
            try:
                data: bytes = body.read(max_bytes + 1)
            finally:
                body.close()
            if len(data) > max_bytes:
                raise ObjectTooLarge(detail="object grew past the limit while reading")
            return data

        result: bytes = await self._run(read)
        return result

    async def download_to_file(
        self, key: str, provider: str, target: Path, *, max_bytes: int
    ) -> int:
        """Stream the object to ``target`` (pipeline audio); returns the bytes written. On any
        failure the partial file is removed."""
        _require_r2(provider)

        def stream() -> int:
            _size, body = self._open_checked(key, max_bytes)
            written = 0
            try:
                with open(target, "wb") as fh:
                    while chunk := body.read(_CHUNK):
                        written += len(chunk)
                        if written > max_bytes:
                            raise ObjectTooLarge(detail="object grew past the limit while reading")
                        fh.write(chunk)
            except BaseException:
                body.close()
                if target.exists():
                    os.remove(target)
                raise
            body.close()
            return written

        result: int = await self._run(stream)
        return result

    async def size(self, key: str, provider: str) -> int | None:
        """Object size in bytes, or None when it does not exist. Unlike v1 (null on any error),
        other failures raise ``StorageError``."""
        _require_r2(provider)
        result: int | None = await self._run(lambda: self._head_size(key))
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
        except (StorageError, StorageObjectNotFound):  # missing bucket = ClientError 404
            return False
        return True

    async def _run[T](self, fn: Callable[[], T]) -> T:
        try:
            return await anyio.to_thread.run_sync(fn)
        except ClientError as exc:
            code = _error_code(exc)
            if code in _MISSING:
                raise StorageObjectNotFound(detail=f"ClientError {code}") from None
            # Error code only: botocore messages can echo request details.
            raise StorageError(detail=f"ClientError {code or ''}".strip()) from None
        except BotoCoreError as exc:
            raise StorageError(detail=type(exc).__name__) from None
