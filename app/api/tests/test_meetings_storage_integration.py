"""ARC-07 part 2: create + Drive upload, uploaded, audio-url, meeting / folder delete and avatars,
end to end against a scratch database with a fake Google Drive (tests/fake_drive.py).

A owns folder F (B editor, C viewer); D is a stranger.
"""

import secrets
import time
import uuid
from collections.abc import Iterator
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.auth.jwt import generate_private_pem, issue_access_token
from app.core.settings import Settings
from app.db.provision import drop_login, ensure_login
from app.db.scratch import admin_url, scratch_database
from app.main import create_app
from app.services.crypto import encrypt_with_key
from app.services.storage.media_token import MediaTokenSigner, derive_media_key
from tests.conftest import alembic_upgrade, requires_db
from tests.fake_drive import CONFIG, ROOT, FakeDrive, FakeFile

pytestmark = requires_db

WEB = "https://app.ricotdin.test"
MASTER = bytes(range(32))


class _Url(str):
    def __repr__(self) -> str:
        return "<database url>"


class _World(dict[str, Any]):
    def __repr__(self) -> str:
        return "<world>"


def _sql(url: str, query: str, *args: Any) -> list[tuple[Any, ...]]:
    with psycopg.connect(url, autocommit=True) as conn:
        cur = conn.execute(query, args)
        return cur.fetchall() if cur.description else []


def _user(url: str, name: str) -> uuid.UUID:
    uid = uuid.uuid4()
    _sql(
        url,
        "INSERT INTO users (id, email, password_hash, role, email_verified_at) "
        "VALUES (%s, %s, 'x', 'user', now())",
        uid,
        f"{name}@example.test",
    )
    _sql(url, "INSERT INTO profiles (id, username, role) VALUES (%s, %s, 'user')", uid, name)
    return uid


@pytest.fixture(scope="module")
def world() -> Iterator[dict[str, Any]]:
    suffix = secrets.token_hex(3)
    owner = admin_url()
    with scratch_database("files") as raw_url:
        url = _Url(raw_url)
        alembic_upgrade(url)
        logins = {
            group: ensure_login(owner, group, f"ricotdin_test_{tag}_{suffix}", connection_limit=5)
            for group, tag in (
                ("ricotdin_app", "fapi"),
                ("ricotdin_service", "fsvc"),
                ("ricotdin_worker", "fwrk"),
            )
        }
        try:
            w = _World(db=url, **{g: _Url(lg.url(url)) for g, lg in logins.items()})
            tag = secrets.token_hex(2)
            for key in "abcd":
                w[key] = _user(url, f"{key}files{tag}")
            w["f"] = _sql(
                url,
                "INSERT INTO folders (user_id, name) VALUES (%s, 'Team') RETURNING id",
                w["a"],
            )[0][0]
            _sql(
                url,
                "INSERT INTO folder_shares (folder_id, user_id, role, invited_by) VALUES "
                "(%s, %s, 'editor', %s), (%s, %s, 'viewer', %s)",
                w["f"], w["b"], w["a"], w["f"], w["c"], w["a"],
            )  # fmt: skip
            sec = encrypt_with_key(CONFIG.client_secret, MASTER)
            ref = encrypt_with_key(CONFIG.refresh_token, MASTER)
            _sql(
                url,
                "INSERT INTO drive_config (client_id, client_secret_ciphertext, client_secret_iv, "
                "client_secret_auth_tag, refresh_token_ciphertext, refresh_token_iv, "
                "refresh_token_auth_tag, root_folder_id, account_email) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                CONFIG.client_id, sec.ciphertext, sec.iv, sec.auth_tag,
                ref.ciphertext, ref.iv, ref.auth_tag, ROOT, CONFIG.account_email,
            )  # fmt: skip
            yield w
        finally:
            for lg in logins.values():
                drop_login(owner, lg.name)


@pytest.fixture(scope="module")
def drive() -> FakeDrive:
    d = FakeDrive()
    d.files[ROOT] = FakeFile({"id": ROOT, "mimeType": "application/vnd.google-apps.folder"})
    return d


@pytest.fixture(scope="module")
def client(world: dict[str, Any], drive: FakeDrive) -> Iterator[TestClient]:
    settings = Settings.model_validate(
        {
            "DATABASE_URL_APP": world["ricotdin_app"],
            "DATABASE_URL_SERVICE": world["ricotdin_service"],
            "DATABASE_URL_WORKER": world["ricotdin_worker"],
            "JWT_PRIVATE_KEY": generate_private_pem(),
            "WEB_ORIGIN": WEB,
            "KEY_ENCRYPTION_SECRET": MASTER.hex(),
        }
    )
    settings.db_pool_app = (2, 0)
    settings.db_pool_service = (2, 0)
    settings.db_pool_worker = (2, 0)
    app = create_app(settings)
    app.state.platform.drive_transport = drive.transport()
    with TestClient(app, base_url="https://api.ricotdin.test") as c:
        keys = app.state.auth.keys
        c.headers_for = {  # type: ignore[attr-defined]
            k: {"Authorization": f"Bearer {issue_access_token(keys, world[k], 'user')}"}
            for k in "abcd"
        }
        yield c


def _as(client: TestClient, who: str) -> dict[str, str]:
    return client.headers_for[who]  # type: ignore[attr-defined, no-any-return]


def _msg(resp: Any) -> str:
    return str(resp.json()["error"]["message"])


def _create(client: TestClient, who: str, data: bytes, **body: Any) -> tuple[str, str]:
    r = client.post("/meetings", headers=_as(client, who), json={"size": len(data), **body})
    assert r.status_code == 200, r.text
    return r.json()["meetingId"], r.json()["uploadUrl"]


def _upload(
    client: TestClient, drive: FakeDrive, who: str, data: bytes = b"a" * 300, **body: Any
) -> tuple[str, str]:
    mid, url = _create(client, who, data, **body)
    fid = drive.upload_via_session(url, data)
    r = client.post(
        f"/meetings/{mid}/uploaded",
        headers=_as(client, who),
        json={"fileId": fid, "size": len(data)},
    )
    assert r.json() == {"ok": True, "meetingId": mid}, r.text
    return mid, fid


# --- create + uploaded ---------------------------------------------------------------------------


def test_create_makes_a_pending_gdrive_meeting_and_a_session(
    client: TestClient, world: dict[str, Any], drive: FakeDrive
) -> None:
    mid, url = _create(
        client, "a", b"x" * 10, mimeType="audio/webm;codecs=opus",
        startedAt="2026-11-02T08:05:00Z", durationSeconds=12,
    )  # fmt: skip
    assert url.startswith("https://www.googleapis.com/upload/drive/v3/files?")
    row = _sql(
        world["db"],
        "SELECT user_id, title, status, source, storage_provider, audio_path, duration_seconds "
        "FROM meetings WHERE id = %s",
        mid,
    )[0]
    assert row == (
        world["a"], "Nov 2, 2026, 3:05 PM", "pending", "recorded", "gdrive",
        f"{world['a']}/{mid}.webm", 12,
    )  # fmt: skip
    session = list(drive.sessions.values())[-1]
    assert session["meta"]["appProperties"] == {"key": f"{world['a']}/{mid}.webm"}
    assert session["origin"] == WEB
    activity = _sql(
        world["db"],
        "SELECT event_type, meeting_id FROM activity_log WHERE user_id = %s ORDER BY created_at "
        "DESC LIMIT 1",
        world["a"],
    )
    assert activity == [("meeting_created", uuid.UUID(mid))]


def test_create_validation_and_folder_rules(client: TestClient, world: dict[str, Any]) -> None:
    r = client.post("/meetings", headers=_as(client, "a"), json={"size": 5, "fileExtension": "exe"})
    assert r.status_code == 400 and _msg(r).startswith("Unsupported file extension")
    assert client.post("/meetings", headers=_as(client, "a"), json={}).status_code == 422
    # viewer cannot create into the folder, editor can
    r = client.post(
        "/meetings", headers=_as(client, "c"), json={"size": 5, "folderId": str(world["f"])}
    )
    assert (r.status_code, _msg(r)) == (404, "Folder not found.")
    r = client.post(
        "/meetings", headers=_as(client, "b"), json={"size": 5, "folderId": str(world["f"])}
    )
    assert r.status_code == 200


def test_uploaded_verifies_and_queues_one_job(
    client: TestClient, world: dict[str, Any], drive: FakeDrive
) -> None:
    mid, fid = _upload(client, drive, "a")
    assert _sql(world["db"], "SELECT count(*) FROM jobs WHERE meeting_id = %s", mid) == [(1,)]
    assert _sql(
        world["db"], "SELECT file_id FROM storage_objects WHERE key LIKE %s", f"%{mid}%"
    ) == [(fid,)]
    # repeating it is harmless: no second job
    r = client.post(
        f"/meetings/{mid}/uploaded", headers=_as(client, "a"), json={"fileId": fid, "size": 300}
    )
    assert r.status_code == 200
    assert _sql(world["db"], "SELECT count(*) FROM jobs WHERE meeting_id = %s", mid) == [(1,)]
    # not pending any more → 409
    _sql(world["db"], "UPDATE meetings SET status = 'processing' WHERE id = %s", mid)
    r = client.post(
        f"/meetings/{mid}/uploaded", headers=_as(client, "a"), json={"fileId": fid, "size": 300}
    )
    assert r.status_code == 409


def test_uploaded_is_owner_only_and_rejects_a_wrong_file(
    client: TestClient, world: dict[str, Any], drive: FakeDrive
) -> None:
    mid, url = _create(client, "a", b"y" * 100)
    fid = drive.upload_via_session(url, b"y" * 99)  # browser sent another size
    for who, status in (("b", 403), ("c", 403), ("d", 403)):
        r = client.post(
            f"/meetings/{mid}/uploaded", headers=_as(client, who), json={"fileId": fid, "size": 100}
        )
        assert r.status_code == status, who
    r = client.post(
        f"/meetings/{mid}/uploaded", headers=_as(client, "a"), json={"fileId": fid, "size": 100}
    )
    assert r.status_code == 422
    assert _sql(world["db"], "SELECT count(*) FROM meetings WHERE id = %s", mid) == [(0,)]
    assert fid in drive.deleted  # its own session file is discarded
    # another user's file id is rejected but never deleted
    _, other = _upload(client, drive, "b")
    mid2, _ = _create(client, "a", b"z" * 300)
    r = client.post(
        f"/meetings/{mid2}/uploaded", headers=_as(client, "a"), json={"fileId": other, "size": 300}
    )
    assert r.status_code == 422 and other in drive.files


# --- audio-url -------------------------------------------------------------------------------------


def test_audio_url_matrix(client: TestClient, world: dict[str, Any], drive: FakeDrive) -> None:
    mid, _ = _upload(client, drive, "a", folderId=str(world["f"]))
    for who in "abc":
        r = client.get(f"/meetings/{mid}/audio-url", headers=_as(client, who))
        assert r.status_code == 200, who
        body = r.json()
        assert body["hackAudioRender"] is False and body["url"].startswith("/media?t=")
        token = body["url"].split("=", 1)[1]
        signer = MediaTokenSigner(derive_media_key(MASTER))
        assert signer.verify(token, now=time.time()) == f"{world['a']}/{mid}.webm"
    assert client.get(f"/meetings/{mid}/audio-url", headers=_as(client, "d")).status_code == 403
    # a forged audio_path is never signed
    _sql(
        world["db"],
        "UPDATE meetings SET audio_path = %s WHERE id = %s",
        f"{world['b']}/x.webm",
        mid,
    )
    r = client.get(f"/meetings/{mid}/audio-url", headers=_as(client, "a"))
    assert (r.status_code, _msg(r)) == (404, "No audio for this meeting.")


def test_media_link_streams_the_uploaded_file(client: TestClient, drive: FakeDrive) -> None:
    data = bytes(range(256)) * 4
    mid, _ = _upload(client, drive, "a", data=data)
    url = client.get(f"/meetings/{mid}/audio-url", headers=_as(client, "a")).json()["url"]
    r = client.get(url, headers={"Range": "bytes=10-19"})
    assert r.status_code == 206 and r.content == data[10:20]


# --- delete ----------------------------------------------------------------------------------------


def test_delete_removes_drive_file_first_and_is_owner_only(
    client: TestClient, world: dict[str, Any], drive: FakeDrive
) -> None:
    mid, fid = _upload(client, drive, "a", folderId=str(world["f"]))
    for who, status in (("b", 403), ("c", 403), ("d", 403)):
        assert client.delete(f"/meetings/{mid}", headers=_as(client, who)).status_code == status
    r = client.delete(f"/meetings/{mid}", headers=_as(client, "a"))
    assert r.json() == {"ok": True}
    assert fid in drive.deleted
    assert _sql(world["db"], "SELECT count(*) FROM meetings WHERE id = %s", mid) == [(0,)]
    assert _sql(world["db"], "SELECT count(*) FROM storage_objects WHERE file_id = %s", fid) == [
        (0,)
    ]
    assert client.delete(f"/meetings/{mid}", headers=_as(client, "a")).status_code == 404


def test_delete_with_storage_failure_still_deletes_the_row(
    client: TestClient, world: dict[str, Any], drive: FakeDrive
) -> None:
    mid, fid = _upload(client, drive, "a")
    drive.fail = [500] * 5
    r = client.delete(f"/meetings/{mid}", headers=_as(client, "a"))
    drive.fail = []
    assert r.json() == {"ok": True, "warning": "Audio file could not be removed from storage."}
    assert _sql(world["db"], "SELECT count(*) FROM meetings WHERE id = %s", mid) == [(0,)]


def test_folder_delete_with_meetings_removes_only_the_owners(
    client: TestClient, world: dict[str, Any], drive: FakeDrive
) -> None:
    fid = _sql(
        world["db"],
        "INSERT INTO folders (user_id, name) VALUES (%s, 'Gone') RETURNING id",
        world["a"],
    )[0][0]
    _sql(
        world["db"],
        "INSERT INTO folder_shares (folder_id, user_id, role, invited_by) VALUES (%s, %s, 'editor', %s)",
        fid, world["b"], world["a"],
    )  # fmt: skip
    mine, my_file = _upload(client, drive, "a", folderId=str(fid))
    theirs, their_file = _upload(client, drive, "b", folderId=str(fid))
    r = client.delete(f"/folders/{fid}?deleteMeetings=true", headers=_as(client, "a"))
    assert r.json() == {"ok": True}
    assert _sql(world["db"], "SELECT count(*) FROM meetings WHERE id = %s", mine) == [(0,)]
    assert _sql(world["db"], "SELECT folder_id FROM meetings WHERE id = %s", theirs) == [(None,)]
    assert my_file in drive.deleted and their_file in drive.files  # BUG-011


# --- avatar ----------------------------------------------------------------------------------------


def test_avatar_upload_confirm_replace(
    client: TestClient, world: dict[str, Any], drive: FakeDrive
) -> None:
    def upload(data: bytes) -> tuple[str, str]:
        r = client.post(
            "/profile/avatar",
            headers=_as(client, "d"),
            json={"contentType": "image/png", "size": len(data)},
        )
        assert r.status_code == 200, r.text
        key = r.json()["avatarKey"]
        return key, drive.upload_via_session(r.json()["uploadUrl"], data)

    key1, file1 = upload(b"p" * 50)
    r = client.patch(
        "/profile", headers=_as(client, "d"),
        json={"avatar_key": key1, "avatar_file_id": file1, "avatar_size": 50},
    )  # fmt: skip
    assert r.json() == {"ok": True}, r.text
    profile = client.get("/profile", headers=_as(client, "d")).json()
    assert profile["avatar_key"] == key1 and profile["avatar_url"].startswith("/media?t=")
    key2, file2 = upload(b"q" * 60)
    r = client.patch(
        "/profile", headers=_as(client, "d"),
        json={"avatar_key": key2, "avatar_file_id": file2, "avatar_size": 60},
    )  # fmt: skip
    assert r.status_code == 200
    assert file1 in drive.deleted and file2 in drive.files  # old avatar removed after the switch
    r = client.patch("/profile", headers=_as(client, "d"), json={"avatar_key": None})
    assert r.status_code == 200 and file2 in drive.deleted
    assert client.get("/profile", headers=_as(client, "d")).json()["avatar_url"] is None


def test_avatar_rules(client: TestClient, world: dict[str, Any]) -> None:
    r = client.post(
        "/profile/avatar", headers=_as(client, "d"), json={"contentType": "image/gif", "size": 1}
    )
    assert r.status_code == 422
    # someone else's key (or audio) can never be stored (BUG-002)
    for key in (f"avatars/{world['a']}/{uuid.uuid4()}.png", f"{world['d']}/{uuid.uuid4()}.webm"):
        r = client.patch(
            "/profile", headers=_as(client, "d"),
            json={"avatar_key": key, "avatar_file_id": "abcDEF123_-xyz", "avatar_size": 1},
        )  # fmt: skip
        assert (r.status_code, _msg(r)) == (422, "Invalid avatar_key."), key


# --- review round 1 regressions -------------------------------------------------------------------


def test_second_uploaded_with_another_file_never_deletes_an_uploaded_meeting(
    client: TestClient, world: dict[str, Any], drive: FakeDrive
) -> None:
    mid, fid = _upload(client, drive, "a")
    for bogus in ("abcDEF123_-nothere", fid[:-1] + "Z"):
        r = client.post(
            f"/meetings/{mid}/uploaded",
            headers=_as(client, "a"),
            json={"fileId": bogus, "size": 300},
        )
        assert (r.status_code, _msg(r)) == (409, "This meeting was already uploaded."), bogus
    assert _sql(world["db"], "SELECT count(*) FROM meetings WHERE id = %s", mid) == [(1,)]
    assert fid in drive.files


def test_uploaded_with_a_missing_file_keeps_the_meeting(
    client: TestClient, world: dict[str, Any], drive: FakeDrive
) -> None:
    mid, _ = _create(client, "a", b"m" * 10)
    r = client.post(
        f"/meetings/{mid}/uploaded", headers=_as(client, "a"),
        json={"fileId": "abcDEF123_-nothere", "size": 10},
    )  # fmt: skip
    assert (r.status_code, _msg(r)) == (422, "File not found in storage — upload may have failed.")
    assert _sql(world["db"], "SELECT count(*) FROM meetings WHERE id = %s", mid) == [(1,)]


def test_uploaded_checks_access_before_the_body(client: TestClient, world: dict[str, Any]) -> None:
    mid, _ = _create(client, "a", b"n" * 10)
    assert (
        client.post(f"/meetings/{mid}/uploaded", headers=_as(client, "d"), json={}).status_code
        == 403
    )
    assert (
        client.post(
            f"/meetings/{uuid.uuid4()}/uploaded", headers=_as(client, "a"), json={}
        ).status_code
        == 404
    )


def test_pending_meetings_are_capped_per_user(
    client: TestClient, world: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.routers.meetings as meetings

    monkeypatch.setattr(meetings, "MAX_PENDING_PER_USER", 1)
    _create(client, "c", b"x")
    r = client.post("/meetings", headers=_as(client, "c"), json={"size": 1})
    assert r.status_code == 429


def test_migration_0004_downgrade_refuses_with_drive_meetings() -> None:
    from tests.conftest import alembic_downgrade

    with scratch_database("m0004") as url:
        alembic_upgrade(url)
        uid = _user(url, f"down{secrets.token_hex(2)}")
        _sql(url, "INSERT INTO meetings (user_id, title) VALUES (%s, 't')", uid)
        assert _sql(url, "SELECT storage_provider FROM meetings") == [("gdrive",)]
        with pytest.raises(Exception, match="gdrive"):
            alembic_downgrade(url, "0003_drive_storage")
