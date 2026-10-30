"""Google Drive storage (ARC-17): v2 keeps meeting audio and avatars in the owner's Drive.

- ``DriveClient`` is long-lived (one per configuration, held by ``Platform``): one HTTP client,
  the OAuth access token cached in memory until 60 s before expiry, retry with backoff on 429,
  rate-limit 403 and 5xx (``drive_rules``). No Google SDK.
- ``DriveStorage`` is built per transaction by ``platform.storage(conn)``: Drive calls plus the
  ``storage_objects`` map (key → Drive file id) read and written on that connection.

Secrets: the refresh token, access token, upload session URIs and media tokens are bearer
credentials. They are never logged; errors carry status codes and reason codes only, never a
Drive response body. httpx2 / httpcore2 log at WARNING (``app.core.logging``).
"""

import hashlib
import random
import re
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import anyio
import httpx2
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.logging import get_logger
from app.services.storage.base import (
    KeyAlreadyStored,
    ObjectTooLarge,
    StorageError,
    StorageHealth,
    StorageNotConfigured,
    StorageObjectNotFound,
    StoredObject,
    UploadRejected,
    base_media_type,
    check_upload_type,
)
from app.services.storage.config import DriveConfig
from app.services.storage.drive_oauth import DRIVE_API, DRIVE_UPLOAD_API, FOLDER_MIME, TOKEN_URL
from app.services.storage.drive_rules import (
    MAX_ATTEMPTS,
    ByteRange,
    error_reason,
    is_retryable,
    is_session_orphan,
    is_valid_file_id,
    retry_delay,
    root_is_private,
    verify_uploaded_file,
)
from app.services.storage.media_token import DEFAULT_MEDIA_TTL_S, MediaTokenSigner

log = get_logger("storage.drive")

TOKEN_MARGIN_S = 60
REJECTED_TOKEN_BACKOFF_S = 30.0
UPLOAD_CHUNK = 8 * 1024 * 1024  # multiple of 256 KiB (Drive resumable rule)
_STREAM_CHUNK = 64 * 1024
_APP_PROPERTY_MAX = 124  # bytes of key + value per Drive appProperty
_FILE_FIELDS = "id,name,mimeType,size,parents,appProperties,md5Checksum,trashed"
_REJECTED_GRANTS = {"invalid_grant", "invalid_client", "unauthorized_client"}

Sleep = Callable[[float], Awaitable[None]]


def _json(resp: httpx2.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return None


class DriveClient:
    """Authenticated, retrying HTTP access to the Drive API for one configuration."""

    def __init__(
        self,
        config: DriveConfig,
        *,
        transport: httpx2.AsyncBaseTransport | None = None,
        sleep: Sleep = anyio.sleep,
        rand: Callable[[], float] = random.random,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.config = config
        self._http = httpx2.AsyncClient(
            transport=transport,
            timeout=httpx2.Timeout(30.0, read=120.0),
            follow_redirects=False,
        )
        self._sleep = sleep
        self._rand = rand
        self._clock = clock
        self._token: str | None = None
        self._token_expires = 0.0
        self._token_lock = anyio.Lock()
        self._rejected_until = 0.0  # a revoked refresh token is not retried for a while

    def __repr__(self) -> str:
        return "DriveClient()"

    async def aclose(self) -> None:
        await self._http.aclose()

    # --- OAuth ---------------------------------------------------------------------------------

    async def access_token(self) -> str:
        async with self._token_lock:
            if self._token and self._clock() < self._token_expires:
                return self._token
            if self._clock() < self._rejected_until:
                raise StorageNotConfigured(detail="drive refresh token was rejected recently")
            data = {
                "client_id": self.config.client_id,
                "client_secret": self.config.client_secret,
                "refresh_token": self.config.refresh_token,
                "grant_type": "refresh_token",
            }
            resp = await self._send(lambda: self._http.post(TOKEN_URL, data=data))
            body = _json(resp)
            if resp.status_code in (400, 401):
                err = body.get("error") if isinstance(body, Mapping) else None
                code = str(err) if isinstance(err, str) and err in _REJECTED_GRANTS else "rejected"
                log.error(
                    "Google Drive refresh token was rejected (%s): re-run "
                    "`python -m scripts.connect_gdrive` to reconnect the account",
                    code,
                )
                self._rejected_until = self._clock() + REJECTED_TOKEN_BACKOFF_S
                raise StorageNotConfigured(detail=f"drive token refresh {code}")
            if resp.status_code != 200 or not isinstance(body, Mapping):
                raise StorageError(detail=f"drive token refresh HTTP {resp.status_code}")
            token = body.get("access_token")
            if not isinstance(token, str) or not token:
                raise StorageError(detail="drive token refresh returned no access token")
            try:
                ttl = int(body.get("expires_in", 3600))
            except (TypeError, ValueError):
                ttl = 3600
            self._token = token
            self._token_expires = self._clock() + max(0, ttl - TOKEN_MARGIN_S)
            return token

    def _drop_token(self) -> None:
        self._token = None
        self._token_expires = 0.0

    # --- requests ------------------------------------------------------------------------------

    async def _send(
        self, call: Callable[[], Awaitable[httpx2.Response]], *, retry: bool = True
    ) -> httpx2.Response:
        """Run ``call`` with retry on transport errors and retryable statuses."""
        attempts = MAX_ATTEMPTS if retry else 1
        for attempt in range(attempts):
            last = attempt == attempts - 1
            try:
                resp = await call()
            except httpx2.TransportError as exc:
                if last:
                    raise StorageError(detail=f"drive transport {type(exc).__name__}") from None
                await self._sleep(retry_delay(attempt, self._rand()))
                continue
            if resp.status_code < 400:
                return resp
            reason = None
            if resp.status_code == 403:
                await resp.aread()  # a streamed response has no body yet; error bodies are small
                reason = error_reason(_json(resp))
            if not retry or not is_retryable(resp.status_code, reason):
                return resp
            await resp.aclose()
            if last:
                raise StorageError(
                    detail=f"drive HTTP {resp.status_code} {reason or ''} after retries".strip()
                )
            await self._sleep(retry_delay(attempt, self._rand()))
        raise AssertionError("unreachable")  # pragma: no cover

    async def request(
        self,
        method: str,
        url: str,
        *,
        params: Mapping[str, str] | None = None,
        json: Any = None,
        content: bytes | None = None,
        headers: Mapping[str, str] | None = None,
        stream: bool = False,
        retry: bool = True,
    ) -> httpx2.Response:
        """An authorised Drive call. A 401 refreshes the access token once."""
        for refreshed in (False, True):
            token = await self.access_token()
            hdrs = {**(headers or {}), "Authorization": f"Bearer {token}"}

            async def call(hdrs: dict[str, str] = hdrs) -> httpx2.Response:
                req = self._http.build_request(
                    method, url, params=params, json=json, content=content, headers=hdrs
                )
                return await self._http.send(req, stream=stream)

            resp = await self._send(call, retry=retry)
            if resp.status_code == 401 and not refreshed:
                await resp.aclose()
                self._drop_token()
                continue
            return resp
        raise AssertionError("unreachable")  # pragma: no cover

    async def get_file(self, file_id: str) -> dict[str, Any] | None:
        if not is_valid_file_id(file_id):
            return None
        resp = await self.request(
            "GET", f"{DRIVE_API}/files/{file_id}", params={"fields": _FILE_FIELDS}
        )
        if resp.status_code == 404:
            return None
        if resp.status_code != 200:
            raise StorageError(detail=f"drive files.get HTTP {resp.status_code}")
        body = _json(resp)
        if not isinstance(body, dict):
            raise StorageError(detail="drive files.get returned no JSON")
        return body

    async def delete_file(self, file_id: str) -> None:
        """Permanent delete (not trash). A missing file counts as deleted. The root folder is
        never deleted (Drive would delete every file in it)."""
        if not is_valid_file_id(file_id):
            return
        if file_id == self.config.root_folder_id:
            raise StorageError(detail="refusing to delete the storage root folder")
        resp = await self.request("DELETE", f"{DRIVE_API}/files/{file_id}")
        if resp.status_code not in (200, 204, 404):
            raise StorageError(detail=f"drive files.delete HTTP {resp.status_code}")

    async def open_media(self, file_id: str, rng: ByteRange | None) -> httpx2.Response:
        """A streamed ``alt=media`` response (200 full, or 206 for ``rng``). Caller closes it."""
        if not is_valid_file_id(file_id):
            raise StorageObjectNotFound(detail="invalid file id")
        headers = {"Accept-Encoding": "identity"}  # bytes must match Content-Length / Range
        if rng:
            headers["Range"] = rng.header
        resp = await self.request(
            "GET",
            f"{DRIVE_API}/files/{file_id}",
            params={"alt": "media"},
            headers=headers,
            stream=True,
        )
        expected = 206 if rng else 200
        if resp.status_code == expected:
            return resp
        await resp.aclose()
        if resp.status_code == 404:
            raise StorageObjectNotFound(detail="drive file is gone")
        raise StorageError(detail=f"drive media HTTP {resp.status_code}, expected {expected}")

    async def create_session(
        self,
        name: str,
        *,
        key: str,
        content_type: str,
        content_length: int,
        origin: str | None,
    ) -> str:
        headers = {
            "X-Upload-Content-Type": content_type,
            "X-Upload-Content-Length": str(content_length),
        }
        if origin:
            headers["Origin"] = origin  # lets the browser PUT to the session URI (CORS)
        resp = await self.request(
            "POST",
            f"{DRIVE_UPLOAD_API}/files",
            params={"uploadType": "resumable", "fields": "id"},
            json={
                "name": name,
                "parents": [self.config.root_folder_id],
                "mimeType": base_media_type(content_type),
                "appProperties": {"key": key},
            },
            headers=headers,
        )
        location = resp.headers.get("location")
        if resp.status_code != 200 or not location:
            raise StorageError(detail=f"drive upload session HTTP {resp.status_code}")
        if not location.startswith(f"{DRIVE_UPLOAD_API}/"):
            raise StorageError(detail="drive upload session URI on an unexpected host")
        return location

    async def put_chunks(self, session_uri: str, path: Path, total: int) -> str:
        """Upload a local file to a resumable session in chunks; returns the file id. Follows the
        offset Drive reports (308 ``Range``); after a failed PUT it asks Drive for the offset
        instead of re-sending blindly."""
        offset = 0
        failures = 0
        async with await anyio.open_file(path, "rb") as fh:
            while True:
                await fh.seek(offset)
                chunk = await fh.read(UPLOAD_CHUNK) if offset < total else b""
                rng = (
                    f"bytes {offset}-{offset + len(chunk) - 1}/{total}"
                    if chunk
                    else f"bytes */{total}"
                )
                try:
                    resp = await self.request(
                        "PUT",
                        session_uri,
                        content=chunk,
                        headers={"Content-Range": rng},
                        retry=False,
                    )
                except StorageError:
                    resp = None
                if resp is not None and resp.status_code in (200, 201):
                    body = _json(resp)
                    file_id = body.get("id") if isinstance(body, Mapping) else None
                    if not isinstance(file_id, str):
                        raise StorageError(detail="drive upload finished without a file id")
                    return file_id
                if resp is not None and resp.status_code == 308:
                    offset = _persisted_offset(resp.headers.get("range"))
                    failures = 0
                    continue
                failures += 1
                status = resp.status_code if resp is not None else "transport"
                if failures >= MAX_ATTEMPTS or (
                    resp is not None and not is_retryable(resp.status_code, None)
                ):
                    raise StorageError(detail=f"drive upload HTTP {status}")
                await self._sleep(retry_delay(failures - 1, self._rand()))
                offset = await self._query_offset(session_uri, total)

    async def _query_offset(self, session_uri: str, total: int) -> int:
        resp = await self.request(
            "PUT", session_uri, content=b"", headers={"Content-Range": f"bytes */{total}"}
        )
        if resp.status_code != 308:
            raise StorageError(detail=f"drive upload status HTTP {resp.status_code}")
        return _persisted_offset(resp.headers.get("range"))

    async def health(self) -> StorageHealth:
        email = self.config.account_email
        try:
            await self.access_token()
        except StorageNotConfigured:
            return StorageHealth(False, "token_refresh_failed", email)
        try:
            root = await self.get_file(self.config.root_folder_id)
            if root is None or root.get("trashed") or root.get("mimeType") != FOLDER_MIME:
                return StorageHealth(False, "root_missing", email)
            perms = await self.request(
                "GET",
                f"{DRIVE_API}/files/{self.config.root_folder_id}/permissions",
                params={"fields": "permissions(type,role,emailAddress)"},
            )
            body = _json(perms)
            if perms.status_code != 200 or not isinstance(body, Mapping):
                return StorageHealth(False, "error", email)
            if not root_is_private(body.get("permissions") or [], email):
                return StorageHealth(False, "shared_root", email)
            about = await self.request(
                "GET", f"{DRIVE_API}/about", params={"fields": "storageQuota(limit,usage)"}
            )
            about_body = _json(about) if about.status_code == 200 else None
            quota = about_body.get("storageQuota") if isinstance(about_body, Mapping) else None
            used, limit = _quota(quota)
        except StorageError as exc:
            log.warning("drive health check failed: %s", exc.detail)
            return StorageHealth(False, "error", email)
        return StorageHealth(True, None, email, used, limit)


def _persisted_offset(range_header: str | None) -> int:
    """Next byte to send after a 308: ``Range: bytes=0-N`` → N + 1; no header → 0."""
    m = re.fullmatch(r"bytes=0-([0-9]{1,19})", range_header or "")
    return int(m.group(1)) + 1 if m else 0


def _quota(quota: Any) -> tuple[int | None, int | None]:
    if not isinstance(quota, Mapping):
        return None, None

    def num(v: Any) -> int | None:
        try:
            return int(v)
        except (TypeError, ValueError):
            return None

    return num(quota.get("usage")), num(quota.get("limit"))


# --- key → file id map ---------------------------------------------------------------------------


_SELECT_OBJECT = (
    "SELECT key, file_id, size_bytes, content_type, md5 FROM storage_objects WHERE key = :key"
)
_SELECT_OBJECT_FOR_UPDATE = _SELECT_OBJECT + " FOR UPDATE"


class ObjectMap(Protocol):
    async def get(self, key: str, *, for_update: bool = False) -> StoredObject | None: ...
    async def insert(self, obj: StoredObject) -> bool:
        """Map a new key; False when the key is already mapped (never overwrites)."""
        ...

    async def delete(self, key: str) -> None: ...


@dataclass
class SqlObjectMap:
    """``storage_objects`` on the caller's connection (ricotdin_service / ricotdin_worker)."""

    conn: AsyncConnection

    async def get(self, key: str, *, for_update: bool = False) -> StoredObject | None:
        query = _SELECT_OBJECT_FOR_UPDATE if for_update else _SELECT_OBJECT
        row = (await self.conn.execute(text(query), {"key": key})).first()
        if row is None:
            return None
        return StoredObject(row.key, row.file_id, int(row.size_bytes), row.content_type, row.md5)

    async def insert(self, obj: StoredObject) -> bool:
        result = await self.conn.execute(
            text(
                "INSERT INTO storage_objects (key, file_id, size_bytes, content_type, md5) "
                "VALUES (:key, :file_id, :size, :ct, :md5) "
                "ON CONFLICT (key) DO NOTHING RETURNING key"
            ),
            {
                "key": obj.key,
                "file_id": obj.file_id,
                "size": obj.size_bytes,
                "ct": obj.content_type,
                "md5": obj.md5,
            },
        )
        return result.first() is not None

    async def delete(self, key: str) -> None:
        await self.conn.execute(text("DELETE FROM storage_objects WHERE key = :key"), {"key": key})


@dataclass
class MemoryObjectMap:
    """In-memory map (tests, smoke checks)."""

    items: dict[str, StoredObject] = field(default_factory=dict)

    async def get(self, key: str, *, for_update: bool = False) -> StoredObject | None:
        return self.items.get(key)

    async def insert(self, obj: StoredObject) -> bool:
        if obj.key in self.items:
            return False
        self.items[obj.key] = obj
        return True

    async def delete(self, key: str) -> None:
        self.items.pop(key, None)


# --- storage -------------------------------------------------------------------------------------


def _check_key(key: str) -> None:
    if not key or len(b"key") + len(key.encode()) > _APP_PROPERTY_MAX:
        raise ValueError("storage key must be 1-121 bytes")


@dataclass
class DriveStorage:
    """``Storage`` on Google Drive. Callers check key ownership first."""

    client: DriveClient
    objects: ObjectMap
    signer: MediaTokenSigner
    web_origin: str | None = None
    clock: Callable[[], float] = time.time

    async def upload_session(
        self, key: str, content_type: str, content_length: int, *, max_bytes: int
    ) -> str:
        """Resumable session URI for a browser upload. Bearer secret: return it once, never log
        it. The browser PUTs the file there, then reports the file id to ``confirm_upload``."""
        _validate_upload(key, content_type, content_length, max_bytes)
        return await self.client.create_session(
            key,
            key=key,
            content_type=content_type,
            content_length=content_length,
            origin=self.web_origin,
        )

    async def confirm_upload(
        self, key: str, file_id: str, *, content_type: str, content_length: int, max_bytes: int
    ) -> StoredObject:
        """Map ``key`` to the file the browser reported, after checking it is the file the
        session for ``key`` created. A key is mapped once: to replace a file, ``delete(key)``
        first (in its own step), then upload again; a confirm for a mapped key answers 409."""
        return await self._confirm(
            key,
            file_id,
            content_type=content_type,
            content_length=content_length,
            max_bytes=max_bytes,
            expected_md5=None,
        )

    async def _confirm(
        self,
        key: str,
        file_id: str,
        *,
        content_type: str,
        content_length: int,
        max_bytes: int,
        expected_md5: str | None,
    ) -> StoredObject:
        _check_key(key)
        meta = await self.client.get_file(file_id)
        if meta is None:
            raise UploadRejected(detail="reported file id does not exist")
        existing = await self.objects.get(key, for_update=True)
        if existing is not None and existing.file_id == file_id:
            raise KeyAlreadyStored(detail="file is already confirmed for this key")
        root = self.client.config.root_folder_id
        reason = verify_uploaded_file(
            meta,
            key=key,
            root_id=root,
            size=content_length,
            content_type=content_type,
            max_bytes=max_bytes,
        )
        md5 = str(meta["md5Checksum"]) if meta.get("md5Checksum") else None
        if reason is None and expected_md5 is not None and md5 != expected_md5:
            reason = "md5_mismatch"
        if reason:
            # Delete only an unmapped file that a session for this very key created in our
            # root: never a file id that belongs to another key, a mapped file or a folder.
            if is_session_orphan(meta, key=key, root_id=root):
                await self._discard(file_id, reason)
            raise UploadRejected(detail=f"uploaded file rejected: {reason}")
        obj = StoredObject(key, file_id, content_length, base_media_type(content_type), md5)
        if existing is not None or not await self.objects.insert(obj):
            await self._discard(file_id, "key_taken")  # this key's session file, never mapped
            raise KeyAlreadyStored(detail="key already maps to another file")
        return obj

    async def _discard(self, file_id: str, reason: str) -> None:
        try:
            await self.client.delete_file(file_id)
        except StorageError:
            log.warning("could not delete a rejected upload (%s)", reason)

    async def upload_file(
        self, key: str, path: Path, content_type: str, *, max_bytes: int
    ) -> StoredObject:
        """Server-side upload of a local file (migration, smoke check): session, chunked PUT,
        then the browser-upload checks plus an md5 match, before the key is mapped."""
        total = (await anyio.Path(path).stat()).st_size
        _validate_upload(key, content_type, total, max_bytes)
        local_md5 = await anyio.to_thread.run_sync(_md5_file, path)
        session = await self.client.create_session(
            key, key=key, content_type=content_type, content_length=total, origin=None
        )
        file_id = await self.client.put_chunks(session, path, total)
        return await self._confirm(
            key,
            file_id,
            content_type=content_type,
            content_length=total,
            max_bytes=max_bytes,
            expected_md5=local_md5,
        )

    def media_url(self, key: str, *, ttl: int = DEFAULT_MEDIA_TTL_S) -> str:
        return f"/media?t={self.signer.sign(key, now=self.clock(), ttl=ttl)}"

    async def stat(self, key: str) -> StoredObject | None:
        return await self.objects.get(key)

    async def _require(self, key: str, max_bytes: int) -> StoredObject:
        obj = await self.objects.get(key)
        if obj is None:
            raise StorageObjectNotFound(detail="key is not in storage_objects")
        if obj.size_bytes > max_bytes:
            raise ObjectTooLarge(detail=f"object is {obj.size_bytes} bytes, limit {max_bytes}")
        return obj

    async def _iter_media(self, obj: StoredObject, max_bytes: int) -> AsyncIterator[bytes]:
        resp = await self.client.open_media(obj.file_id, None)
        read = 0
        try:
            async for chunk in resp.aiter_bytes(_STREAM_CHUNK):
                read += len(chunk)
                if read > max_bytes:
                    raise ObjectTooLarge(detail="object grew past the limit while reading")
                yield chunk
        except httpx2.TransportError as exc:
            raise StorageError(detail=f"drive read {type(exc).__name__}") from None
        finally:
            await resp.aclose()

    async def get_bytes(self, key: str, *, max_bytes: int) -> bytes:
        """Whole file in memory — small files only (avatars)."""
        obj = await self._require(key, max_bytes)
        parts = [chunk async for chunk in self._iter_media(obj, max_bytes)]
        return b"".join(parts)

    async def download_to_file(self, key: str, target: Path, *, max_bytes: int) -> int:
        """Stream to ``target`` (pipeline audio); the partial file is removed on failure."""
        obj = await self._require(key, max_bytes)
        written = 0
        try:
            async with await anyio.open_file(target, "wb") as fh:
                async for chunk in self._iter_media(obj, max_bytes):
                    written += len(chunk)
                    await fh.write(chunk)
        except BaseException:
            with anyio.CancelScope(shield=True):  # remove it even when cancelled
                await anyio.Path(target).unlink(missing_ok=True)
            raise
        return written

    async def size(self, key: str) -> int | None:
        obj = await self.objects.get(key)
        return obj.size_bytes if obj else None

    async def delete(self, key: str) -> None:
        """Permanent delete from Drive, then the map row. A missing key is a no-op."""
        obj = await self.objects.get(key, for_update=True)
        if obj is None:
            return
        await self.client.delete_file(obj.file_id)
        await self.objects.delete(key)

    async def delete_many(self, keys: list[str]) -> list[str]:
        failed: list[str] = []
        for key in keys:
            try:
                await self.delete(key)
            except Exception:  # noqa: BLE001 - reported to the caller as a warning
                failed.append(key)
        return failed

    async def check(self) -> StorageHealth:
        """Token refresh, root folder present and private, quota. Never raises."""
        try:
            return await self.client.health()
        except Exception as exc:  # noqa: BLE001 - admin health check
            log.warning("drive health check error (%s)", type(exc).__name__)
            return StorageHealth(False, "error", self.client.config.account_email)


def _validate_upload(key: str, content_type: str, size: int, max_bytes: int) -> None:
    _check_key(key)
    check_upload_type(content_type)
    if size <= 0:
        raise ValueError("size must be > 0")
    if size > max_bytes:
        raise ObjectTooLarge(detail=f"file is {size} bytes, limit {max_bytes}")


def _md5_file(path: Path) -> str:
    h = hashlib.md5(usedforsecurity=False)
    with open(path, "rb") as fh:
        while block := fh.read(1024 * 1024):
            h.update(block)
    return h.hexdigest()
