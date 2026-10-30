"""ARC-17: DriveStorage / DriveClient against an in-memory fake Drive (no network, no DB)."""

import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path
from typing import Any

import anyio
import httpx2
import pytest

from app.services.storage.base import (
    KeyAlreadyStored,
    ObjectTooLarge,
    StorageError,
    StorageNotConfigured,
    StorageObjectNotFound,
    UnsupportedContentType,
    UploadRejected,
)
from app.services.storage.drive_rules import ByteRange
from app.services.storage.gdrive import DriveClient, DriveStorage, MemoryObjectMap
from app.services.storage.media_token import MediaTokenSigner, derive_media_key
from tests.fake_drive import CONFIG, OWNER, ROOT, UPLOAD, FakeDrive, FakeFile

KEY = "11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.webm"
CT = "audio/webm;codecs=opus"
MAX = 10_000
SIGNER = MediaTokenSigner(derive_media_key(bytes(range(32))))


class Env:
    def __init__(self, drive: FakeDrive | None = None) -> None:
        self.drive = drive or FakeDrive()
        self.sleeps: list[float] = []
        self.clock = 1000.0

        async def sleep(s: float) -> None:
            self.sleeps.append(s)

        self.client = DriveClient(
            CONFIG,
            transport=self.drive.transport(),
            sleep=sleep,
            rand=lambda: 0.5,
            clock=lambda: self.clock,
        )
        self.objects = MemoryObjectMap()
        self.storage = DriveStorage(
            self.client, self.objects, SIGNER, web_origin="https://app.example.com"
        )


def run[T](fn: Callable[[], Awaitable[T]]) -> T:
    return anyio.run(fn)


async def _store(env: Env, data: bytes, key: str = KEY) -> str:
    uri = await env.storage.upload_session(key, CT, len(data), max_bytes=MAX)
    fid = env.drive.upload_via_session(uri, data)
    await env.storage.confirm_upload(
        key, fid, content_type=CT, content_length=len(data), max_bytes=MAX
    )
    return fid


# --- token ----------------------------------------------------------------------------------------


def test_access_token_is_cached_until_60s_before_expiry() -> None:
    env = Env()

    async def go() -> list[str]:
        a = await env.client.access_token()
        env.clock += 3599 - 61
        b = await env.client.access_token()
        env.clock += 2
        c = await env.client.access_token()
        return [a, b, c]

    assert run(go) == ["at-1", "at-1", "at-2"]
    assert env.drive.token_calls == 2


def test_revoked_refresh_token_raises_not_configured_without_leaking_secrets(
    caplog: pytest.LogCaptureFixture,
) -> None:
    env = Env(FakeDrive(token_error="invalid_grant"))
    caplog.set_level(logging.DEBUG)
    with pytest.raises(StorageNotConfigured) as exc:
        run(lambda: env.storage.upload_session(KEY, CT, 10, max_bytes=MAX))
    assert exc.value.status == 503
    assert "connect_gdrive" in caplog.text and "invalid_grant" in caplog.text
    for secret in (CONFIG.refresh_token, CONFIG.client_secret, "Token revoked"):
        assert secret not in caplog.text
        assert secret not in str(exc.value)


def test_401_from_drive_refreshes_the_token_once() -> None:
    env = Env(FakeDrive(reject_token="at-1"))
    fid = env.drive.add_file(b"x" * 10, key=KEY)
    meta = run(lambda: env.client.get_file(fid))
    assert meta is not None and meta["id"] == fid
    assert env.drive.token_calls == 2


# --- upload session + confirm -----------------------------------------------------------------------


def test_upload_session_binds_type_size_parent_key_and_origin() -> None:
    env = Env()
    uri = run(lambda: env.storage.upload_session(KEY, CT, 1234, max_bytes=MAX))
    assert uri.startswith(f"{UPLOAD}?") and "upload_id=" in uri
    s = env.drive.sessions["S1"]
    assert s["meta"] == {
        "name": KEY,
        "parents": [ROOT],
        "mimeType": "audio/webm",
        "appProperties": {"key": KEY},
    }
    assert s["length"] == 1234 and s["origin"] == "https://app.example.com"
    req = env.drive.drive_requests()[0]
    assert req.headers["x-upload-content-type"] == CT
    assert req.url.params["uploadType"] == "resumable"


@pytest.mark.parametrize(
    ("ct", "size", "exc"),
    [
        ("text/html", 10, UnsupportedContentType),
        ("image/svg+xml", 10, UnsupportedContentType),
        (CT, MAX + 1, ObjectTooLarge),
        (CT, 0, ValueError),
    ],
)
def test_upload_session_refuses_bad_type_or_size(ct: str, size: int, exc: type[Exception]) -> None:
    env = Env()
    with pytest.raises(exc):
        run(lambda: env.storage.upload_session(KEY, ct, size, max_bytes=MAX))
    assert env.drive.drive_requests() == []


def test_upload_session_refuses_a_key_too_long_for_app_properties() -> None:
    env = Env()
    with pytest.raises(ValueError):
        run(lambda: env.storage.upload_session("k" * 122, CT, 10, max_bytes=MAX))


def test_matching_upload_is_confirmed_and_mapped() -> None:
    env = Env()
    data = b"a" * 500
    fid = run(lambda: _store(env, data))
    obj = env.objects.items[KEY]
    assert (obj.file_id, obj.size_bytes, obj.content_type) == (fid, 500, "audio/webm")
    assert obj.md5 == env.drive.files[fid].meta["md5Checksum"]
    assert run(lambda: env.storage.size(KEY)) == 500


@pytest.mark.parametrize(
    ("meta", "declared"),
    [
        ({"mimeType": "text/html"}, 100),
        ({}, 99),  # browser uploaded more than it declared
        ({"trashed": True}, 100),
    ],
)
def test_own_session_file_that_mismatches_is_deleted_and_rejected(
    meta: dict[str, Any], declared: int
) -> None:
    env = Env()
    fid = env.drive.add_file(b"z" * 100, key=KEY, **meta)
    with pytest.raises(UploadRejected) as exc:
        run(
            lambda: env.storage.confirm_upload(
                KEY, fid, content_type=CT, content_length=declared, max_bytes=MAX
            )
        )
    assert exc.value.status == 422
    assert fid in env.drive.deleted and fid not in env.drive.files
    assert env.objects.items == {}


@pytest.mark.parametrize(
    "meta",
    [
        {"appProperties": {"key": "someone/else.webm"}},  # another user's file
        {"appProperties": None},
        {"parents": ["another-folder"]},
        {"mimeType": "application/vnd.google-apps.folder"},
    ],
)
def test_file_not_created_for_this_key_is_rejected_but_never_deleted(meta: dict[str, Any]) -> None:
    env = Env()
    fid = env.drive.add_file(b"z" * 100, key=KEY, **meta)
    with pytest.raises(UploadRejected):
        run(
            lambda: env.storage.confirm_upload(
                KEY, fid, content_type=CT, content_length=100, max_bytes=MAX
            )
        )
    assert fid in env.drive.files and env.drive.deleted == []


def test_reporting_the_root_folder_id_never_deletes_it() -> None:
    env = Env(_with_root(FakeDrive()))
    with pytest.raises(UploadRejected):
        run(
            lambda: env.storage.confirm_upload(
                KEY, ROOT, content_type=CT, content_length=1, max_bytes=MAX
            )
        )
    assert ROOT in env.drive.files and env.drive.deleted == []
    with pytest.raises(StorageError):
        run(lambda: env.client.delete_file(ROOT))
    assert ROOT in env.drive.files


def test_reconfirming_a_mapped_file_with_wrong_values_does_not_delete_it() -> None:
    env = Env()
    fid = run(lambda: _store(env, b"a" * 50))
    with pytest.raises(KeyAlreadyStored):
        run(
            lambda: env.storage.confirm_upload(
                KEY, fid, content_type=CT, content_length=49, max_bytes=MAX
            )
        )
    assert fid in env.drive.files and env.objects.items[KEY].file_id == fid


@pytest.mark.parametrize("fid", ["missing-file-0000", "../../about", "a?alt=media"])
def test_unknown_or_malformed_file_id_is_rejected_without_a_drive_path(fid: str) -> None:
    env = Env()
    with pytest.raises(UploadRejected):
        run(
            lambda: env.storage.confirm_upload(
                KEY, fid, content_type=CT, content_length=1, max_bytes=MAX
            )
        )
    assert all("about" not in r.url.path for r in env.drive.drive_requests())


def test_a_mapped_key_is_never_replaced_the_new_upload_is_discarded() -> None:
    # Replacing inside the caller's transaction could delete the old file and then roll back
    # the map: callers delete(key) first, then upload again.
    env = Env()
    first = run(lambda: _store(env, b"1" * 10))
    with pytest.raises(KeyAlreadyStored) as exc:
        run(lambda: _store(env, b"2" * 20))
    assert exc.value.status == 409
    assert env.objects.items[KEY].file_id == first and first in env.drive.files
    assert len(env.drive.deleted) == 1 and env.drive.deleted[0] != first
    run(lambda: env.storage.delete(KEY))
    second = run(lambda: _store(env, b"2" * 20))
    assert env.objects.items[KEY].file_id == second


def test_server_side_upload_file_in_chunks(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import app.services.storage.gdrive as gdrive

    monkeypatch.setattr(gdrive, "UPLOAD_CHUNK", 256 * 1024)
    env = Env()
    data = bytes(range(256)) * 4000  # ~1 MiB → 4 chunks
    src = tmp_path / "a.webm"
    src.write_bytes(data)
    obj = run(lambda: env.storage.upload_file(KEY, src, "audio/webm", max_bytes=len(data)))
    assert env.drive.files[obj.file_id].data == data
    puts = [r for r in env.drive.drive_requests() if r.method == "PUT"]
    assert len(puts) == 4
    assert puts[0].headers["content-range"] == f"bytes 0-262143/{len(data)}"


# --- reads ------------------------------------------------------------------------------------------


def test_media_url_is_a_signed_relative_path() -> None:
    env = Env()
    env.storage.clock = lambda: 2_000_000_000.0
    url = env.storage.media_url(KEY, ttl=60)
    assert url.startswith("/media?t=")
    assert SIGNER.verify(url.split("=", 1)[1], now=2_000_000_010.0) == KEY


def test_open_media_range_returns_exactly_those_bytes() -> None:
    env = Env()
    data = bytes(range(256)) * 10
    fid = run(lambda: _store(env, data))

    async def go() -> tuple[int, bytes]:
        resp = await env.client.open_media(fid, ByteRange(1000, 1999))
        try:
            return resp.status_code, await resp.aread()
        finally:
            await resp.aclose()

    status, body = run(go)
    assert status == 206 and body == data[1000:2000]


def test_get_bytes_and_download_respect_max_bytes(tmp_path: Path) -> None:
    env = Env()
    data = b"q" * 300
    run(lambda: _store(env, data))
    assert run(lambda: env.storage.get_bytes(KEY, max_bytes=300)) == data
    with pytest.raises(ObjectTooLarge):
        run(lambda: env.storage.get_bytes(KEY, max_bytes=299))
    target = tmp_path / "out.webm"
    assert run(lambda: env.storage.download_to_file(KEY, target, max_bytes=300)) == 300
    assert target.read_bytes() == data
    with pytest.raises(StorageObjectNotFound):
        run(lambda: env.storage.get_bytes("nope", max_bytes=300))


def test_download_removes_the_partial_file_when_the_file_is_bigger_than_mapped(
    tmp_path: Path,
) -> None:
    env = Env()
    fid = run(lambda: _store(env, b"r" * 100))
    env.drive.files[fid].data = b"r" * 500  # changed behind our back
    target = tmp_path / "out.webm"
    with pytest.raises(ObjectTooLarge):
        run(lambda: env.storage.download_to_file(KEY, target, max_bytes=200))
    assert not target.exists()


# --- delete -------------------------------------------------------------------------------------------


def test_delete_twice_removes_file_and_row_permanently_and_is_idempotent() -> None:
    env = Env()
    fid = run(lambda: _store(env, b"d" * 10))
    run(lambda: env.storage.delete(KEY))
    assert fid in env.drive.deleted and fid not in env.drive.files
    assert KEY not in env.objects.items
    deletes = [r for r in env.drive.drive_requests() if r.method == "DELETE"]
    assert len(deletes) == 1 and "trash" not in str(deletes[0].url)
    run(lambda: env.storage.delete(KEY))  # no-op
    assert len([r for r in env.drive.drive_requests() if r.method == "DELETE"]) == 1


def test_delete_when_drive_already_lost_the_file_still_drops_the_row() -> None:
    env = Env()
    fid = run(lambda: _store(env, b"d" * 10))
    del env.drive.files[fid]
    run(lambda: env.storage.delete(KEY))
    assert KEY not in env.objects.items


def test_delete_many_reports_failures_and_never_raises() -> None:
    env = Env()
    run(lambda: _store(env, b"d" * 10))
    env.drive.fail = [500] * 5
    assert run(lambda: env.storage.delete_many([KEY, "missing"])) == [KEY]
    assert KEY in env.objects.items  # row kept when Drive delete failed


# --- retry --------------------------------------------------------------------------------------------


def test_429_four_times_then_success() -> None:
    env = Env()
    fid = env.drive.add_file(b"x", key=KEY)
    env.drive.fail = [429, 429, 429, 429]
    assert run(lambda: env.client.get_file(fid)) is not None
    assert len(env.sleeps) == 4 and env.sleeps == sorted(env.sleeps)


def test_five_failures_raise_storage_error() -> None:
    env = Env()
    fid = env.drive.add_file(b"x", key=KEY)
    env.drive.fail = [503] * 5
    with pytest.raises(StorageError) as exc:
        run(lambda: env.client.get_file(fid))
    assert exc.value.status == 503 and len(env.sleeps) == 4


def test_rate_limit_403_is_retried_but_permission_403_is_not() -> None:
    env = Env(FakeDrive(fail_reason="userRateLimitExceeded"))
    fid = env.drive.add_file(b"x", key=KEY)
    env.drive.fail = [403]
    assert run(lambda: env.client.get_file(fid)) is not None
    env2 = Env(FakeDrive(fail_reason="insufficientPermissions"))
    fid2 = env2.drive.add_file(b"x", key=KEY)
    env2.drive.fail = [403]
    with pytest.raises(StorageError):
        run(lambda: env2.client.get_file(fid2))
    assert env2.sleeps == []


# --- check ----------------------------------------------------------------------------------------------


def _with_root(drive: FakeDrive) -> FakeDrive:
    drive.files[ROOT] = FakeFile(
        {"id": ROOT, "mimeType": "application/vnd.google-apps.folder", "trashed": False}
    )
    return drive


def test_check_ok_reports_quota() -> None:
    env = Env(_with_root(FakeDrive()))
    health = run(env.storage.check)
    assert health.ok and health.problem is None
    assert health.account_email == OWNER
    assert health.quota_limit == 5497558138880 and health.quota_used == 1024


def test_check_reports_shared_root() -> None:
    drive = _with_root(FakeDrive())
    drive.permissions.append({"type": "anyone", "role": "reader"})
    health = run(Env(drive).storage.check)
    assert not health.ok and health.problem == "shared_root"


def test_check_reports_missing_root_and_revoked_token() -> None:
    assert run(Env().storage.check).problem == "root_missing"
    assert run(Env(FakeDrive(token_error="invalid_grant")).storage.check).problem == (
        "token_refresh_failed"
    )


# --- review round 1 regressions ------------------------------------------------------------------


def test_streamed_rate_limit_403_is_read_retried_and_closed() -> None:
    env = Env()
    data = b"m" * 100
    fid = run(lambda: _store(env, data))
    calls = {"n": 0}
    inner = env.drive.handle

    def handle(request: httpx2.Request) -> httpx2.Response:
        if request.url.params.get("alt") == "media" and calls["n"] == 0:
            calls["n"] += 1

            async def body() -> AsyncIterator[bytes]:
                yield b'{"error": {"errors": [{"reason": "rateLimitExceeded"}]}}'

            return httpx2.Response(403, content=body())
        return inner(request)

    env.client._http = httpx2.AsyncClient(transport=httpx2.MockTransport(handle))

    async def go() -> bytes:
        resp = await env.client.open_media(fid, None)
        try:
            return await resp.aread()
        finally:
            await resp.aclose()

    assert run(go) == data and len(env.sleeps) == 1


def test_upload_follows_the_offset_drive_persisted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.services.storage.gdrive as gdrive

    monkeypatch.setattr(gdrive, "UPLOAD_CHUNK", 256 * 1024)
    env = Env()
    env.drive.persist_limit = 100_000  # Drive keeps only part of each chunk
    data = bytes(range(256)) * 2000
    src = tmp_path / "a.webm"
    src.write_bytes(data)
    obj = run(lambda: env.storage.upload_file(KEY, src, "audio/webm", max_bytes=len(data)))
    assert env.drive.files[obj.file_id].data == data


def test_upload_recovers_from_a_failed_chunk_by_asking_for_the_offset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.services.storage.gdrive as gdrive

    monkeypatch.setattr(gdrive, "UPLOAD_CHUNK", 256 * 1024)
    env = Env()
    env.drive.fail_put_once = True
    data = bytes(range(256)) * 2000
    src = tmp_path / "a.webm"
    src.write_bytes(data)
    obj = run(lambda: env.storage.upload_file(KEY, src, "audio/webm", max_bytes=len(data)))
    assert env.drive.files[obj.file_id].data == data
    status_queries = [
        r
        for r in env.drive.drive_requests()
        if r.headers.get("content-range", "").startswith("bytes */")
    ]
    assert len(status_queries) == 1


def test_md5_mismatch_is_rejected_before_mapping(tmp_path: Path) -> None:
    env = Env()
    env.drive.corrupt_md5 = True
    src = tmp_path / "a.webm"
    src.write_bytes(b"x" * 1000)
    with pytest.raises(UploadRejected):
        run(lambda: env.storage.upload_file(KEY, src, "audio/webm", max_bytes=1000))
    assert env.objects.items == {} and env.drive.files == {}


def test_revoked_token_is_not_retried_for_30_seconds() -> None:
    env = Env(FakeDrive(token_error="invalid_grant"))
    for _ in range(3):
        with pytest.raises(StorageNotConfigured):
            run(env.client.access_token)
    assert env.drive.token_calls == 1
    env.clock += 31
    with pytest.raises(StorageNotConfigured):
        run(env.client.access_token)
    assert env.drive.token_calls == 2


def test_media_request_asks_for_identity_encoding() -> None:
    env = Env()
    fid = run(lambda: _store(env, b"e" * 10))

    async def go() -> None:
        resp = await env.client.open_media(fid, None)
        await resp.aclose()

    run(go)
    media = [r for r in env.drive.drive_requests() if r.url.params.get("alt") == "media"]
    assert media[-1].headers["accept-encoding"] == "identity"
