"""Storage contract for v2 (ARC-17). ARC-07/08/10 code against ``Storage``; the implementation is
``DriveStorage`` (Google Drive). ``r2.py`` remains only as an ARC-18 source reader.

Callers must prove ownership of a key first (``app.services.storage.ownership``): storage
accepts any key. Uploads are media only; every read takes ``max_bytes``.
"""

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from app.core.errors import AppError, Conflict, NotFound, ServiceUnavailable

# Media only: an uploaded text/html or SVG file would be served back from our origin.
_UPLOAD_TYPES = re.compile(r"(?:audio|video)/[a-z0-9][a-z0-9.+-]*|image/(?:jpeg|png|webp)")


class UnsupportedContentType(AppError):
    status = 415
    code = "unsupported_content_type"
    message = "This file type cannot be uploaded."


class StorageNotConfigured(ServiceUnavailable):
    code = "storage_not_configured"
    message = "Storage is not configured yet. Please contact an administrator."


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


class KeyAlreadyStored(Conflict):
    code = "file_already_stored"
    message = "A file is already stored here. Delete it before uploading a new one."


class UploadRejected(AppError):
    status = 422
    code = "upload_rejected"
    message = "The uploaded file does not match what was expected. Please upload it again."


def base_media_type(content_type: str) -> str:
    """``Audio/WebM; codecs=opus`` → ``audio/webm``."""
    return content_type.split(";", 1)[0].strip().lower()


def check_upload_type(content_type: str) -> None:
    if not _UPLOAD_TYPES.fullmatch(base_media_type(content_type)):
        raise UnsupportedContentType(
            detail="upload content type must be audio/*, video/* or a jpeg/png/webp image"
        )


@dataclass(frozen=True)
class StoredObject:
    key: str
    file_id: str
    size_bytes: int
    content_type: str
    md5: str | None


@dataclass(frozen=True)
class StorageHealth:
    ok: bool
    # not_configured | token_refresh_failed | root_missing | shared_root | error
    problem: str | None = None
    account_email: str | None = None
    quota_used: int | None = None
    quota_limit: int | None = None


class Storage(Protocol):
    async def upload_session(
        self, key: str, content_type: str, content_length: int, *, max_bytes: int
    ) -> str:
        """A one-time upload URL the browser PUTs the file to (a bearer secret: never log it)."""
        ...

    async def confirm_upload(
        self, key: str, file_id: str, *, content_type: str, content_length: int, max_bytes: int
    ) -> StoredObject:
        """Verify the file the browser reported and map ``key`` to it. 422 when it is not the
        file the session for ``key`` created; 409 when ``key`` is already mapped (a key is
        never replaced: ``delete(key)`` first, in its own step)."""
        ...

    def media_url(self, key: str, *, ttl: int = ...) -> str:
        """A short-lived, path-relative playback URL (``/media?t=...``) on the API origin."""
        ...

    async def stat(self, key: str) -> StoredObject | None: ...

    async def get_bytes(self, key: str, *, max_bytes: int) -> bytes: ...

    async def download_to_file(self, key: str, target: Path, *, max_bytes: int) -> int: ...

    async def size(self, key: str) -> int | None: ...

    async def delete(self, key: str) -> None: ...

    async def delete_many(self, keys: list[str]) -> list[str]:
        """Returns the keys that failed. Never raises."""
        ...

    async def check(self) -> StorageHealth: ...
