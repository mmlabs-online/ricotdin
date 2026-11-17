# ruff: noqa: F811 - pytest fixtures imported from the storage route tests are parameters here
"""PRF-13 / ADM-11: export and self-delete end to end (scratch database, the real API, fake Drive).
The export holds only the caller's own meetings (names applied), chats, activity and profile;
self-delete needs the username, removes the Drive files first, then every row; an admin exports one
user (audited); exports are rate limited."""

import io
import json
import secrets
import uuid
import zipfile
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.core.ratelimit import RateLimiter
from tests.conftest import requires_db
from tests.fake_drive import FakeDrive
from tests.mmlabs_auth import bearer
from tests.test_meetings_storage_integration import (  # noqa: F401 - fixtures
    _as,
    _sql,
    _upload,
    _user,
    client,
    drive,
    world,
)

pytestmark = requires_db


@pytest.fixture(autouse=True)
def _fresh_limit(client: TestClient) -> None:
    app: Any = client.app
    app.state.export_limiter = __import__("app.services.account", fromlist=["x"]).export_limiter()


def _zip(resp: Any) -> zipfile.ZipFile:
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "application/zip"
    assert resp.headers["content-disposition"].startswith('attachment; filename="ricotdin-export-')
    return zipfile.ZipFile(io.BytesIO(resp.content))


def _meeting(world: dict[str, Any], owner: uuid.UUID, title: str, folder: Any = None) -> uuid.UUID:
    mid = uuid.uuid4()
    _sql(world["db"], "INSERT INTO meetings (id, user_id, title, status, summary, folder_id, "
         "speaker_names) VALUES (%s, %s, %s, 'done', 'Tóm tắt', %s, "
         "'{\"Speaker 1\": \"Lan\"}')", mid, owner, title, folder)  # fmt: skip
    _sql(world["db"], "INSERT INTO transcript_segments (meeting_id, segment_index, speaker, "
         "start_ms, end_ms, text) VALUES (%s, 0, 'Speaker 1', 0, 1000, 'xin chào')", mid)  # fmt: skip
    return mid


def test_export_holds_only_the_callers_own_data(client: TestClient, world: dict[str, Any]) -> None:
    mine = _meeting(world, world["a"], "Họp của A", folder=world["f"])
    other = _meeting(world, world["b"], "Họp của B", folder=world["f"])  # in A's folder
    session = _sql(world["db"], "INSERT INTO chat_sessions (user_id, meeting_id) VALUES (%s, %s) "
                   "RETURNING id", world["a"], mine)[0][0]  # fmt: skip
    _sql(world["db"], "INSERT INTO chat_messages (session_id, role, content) VALUES "
         "(%s, 'user', 'Câu hỏi của A')", session)  # fmt: skip
    _sql(world["db"], "INSERT INTO activity_log (user_id, event_type) VALUES (%s, 'record_start')",
         world["a"])  # fmt: skip
    z = _zip(client.get("/profile/export", headers=_as(client, "a")))
    names = z.namelist()
    folder = f"meetings/{[n for n in names if str(mine)[:8] in n][0].split('/')[1]}"
    assert f"{folder}/meeting.md" in names and f"{folder}/meeting.json" in names
    assert not any(str(other)[:8] in n for n in names)  # B's meeting in A's folder: not A's data
    md = z.read(f"{folder}/meeting.md").decode()
    assert "# Họp của A" in md and "**Lan**" in md and "xin chào" in md
    assert "Câu hỏi của A" in z.read("chats.json").decode()
    assert json.loads(z.read("profile.json"))["id"] == str(world["a"])
    assert any(a["event_type"] == "record_start" for a in json.loads(z.read("activity.json")))
    blob = b"".join(z.read(n) for n in names)
    assert "Họp của B".encode() not in blob
    audit = _sql(world["db"], "SELECT action, actor_id FROM audit_logs WHERE target_id = %s "
                 "AND action = 'user.export_self'", str(world["a"]))  # fmt: skip
    assert audit and audit[-1] == ("user.export_self", world["a"])


def test_exports_are_rate_limited(client: TestClient) -> None:
    app: Any = client.app
    app.state.export_limiter = RateLimiter(capacity=1, refill_per_second=0.0001)
    assert client.get("/profile/export", headers=_as(client, "c")).status_code == 200
    assert client.get("/profile/export", headers=_as(client, "c")).status_code == 429


def test_an_admin_exports_one_user_and_it_is_audited(
    client: TestClient, world: dict[str, Any]
) -> None:
    _sql(world["db"], "UPDATE users SET role = 'admin' WHERE id = %s", world["c"])
    admin = bearer(world["c"], "admin")
    mid = _meeting(world, world["b"], "Họp B riêng")
    z = _zip(client.get(f"/admin/users/{world['b']}/export", headers=admin))
    assert any(str(mid)[:8] in n for n in z.namelist())
    assert _sql(world["db"], "SELECT action, actor_id FROM audit_logs WHERE target_id = %s AND "
                "action = 'user.export'", str(world["b"]))[-1] == ("user.export", world["c"])  # fmt: skip
    assert (
        client.get(f"/admin/users/{world['b']}/export", headers=_as(client, "b")).status_code == 403
    )
    assert client.get(f"/admin/users/{uuid.uuid4()}/export", headers=admin).status_code == 404
    _sql(world["db"], "UPDATE users SET role = 'user' WHERE id = %s", world["c"])


def test_self_delete_needs_the_username_then_removes_files_and_rows(
    client: TestClient, world: dict[str, Any], drive: FakeDrive
) -> None:
    uid = _user(world["db"], f"gone{secrets.token_hex(3)}")
    username = _sql(world["db"], "SELECT username FROM profiles WHERE id = %s", uid)[0][0]
    headers = bearer(uid)
    client.headers_for["z"] = headers  # type: ignore[attr-defined]
    mid, fid = _upload(client, drive, "z")
    # A's meeting in a folder Z owns stays (uncategorized) when Z goes
    zfolder = _sql(world["db"], "INSERT INTO folders (user_id, name) VALUES (%s, 'Z') RETURNING id",
                   uid)[0][0]  # fmt: skip
    kept = _meeting(world, world["a"], "Còn lại", folder=zfolder)
    for body in ({}, {"confirm": "wrong"}, {"confirm": username.upper()}):
        r = client.request("DELETE", "/profile", headers=headers, json=body)
        assert r.status_code == 400, body
    assert _sql(world["db"], "SELECT count(*) FROM users WHERE id = %s", uid) == [(1,)]
    r = client.request("DELETE", "/profile", headers=headers, json={"confirm": username})
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True}
    assert fid in drive.deleted
    assert _sql(world["db"], "SELECT count(*) FROM users WHERE id = %s", uid) == [(0,)]
    assert _sql(world["db"], "SELECT count(*) FROM meetings WHERE id = %s", mid) == [(0,)]
    assert _sql(world["db"], "SELECT folder_id FROM meetings WHERE id = %s", kept) == [(None,)]
    actions = [r[0] for r in _sql(world["db"], "SELECT action FROM audit_logs WHERE target_id = %s "
                                  "ORDER BY created_at", str(uid))]  # fmt: skip
    assert actions == ["user.delete_self_started", "user.delete_self"]
    assert client.get("/profile/export").status_code == 401
