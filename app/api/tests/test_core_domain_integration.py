"""ARC-07 part 1: core-domain endpoints end to end against a scratch database.

Role matrix from the v1 handlers (contract in ai-instruction/v2-tracking.md table (b)):
A owns folder F1 and meeting M1 (in F1); B is editor on F1 and owns M2 (also in F1, so A is
M2's folder owner); C is viewer on F1; D is a stranger; E is an admin with no share (admins get no
extra access to content).
"""

import secrets
import uuid
from collections.abc import Iterator
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.auth.jwt import generate_private_pem, issue_access_token
from app.core.ratelimit import RateLimiter
from app.core.settings import Settings
from app.db.provision import drop_login, ensure_login
from app.db.scratch import admin_url, scratch_database
from app.main import create_app
from tests.conftest import alembic_upgrade, requires_db

pytestmark = requires_db

WEB = "https://app.ricotdin.test"


class _Url(str):
    """A connection string that never shows up in a traceback (pytest prints argument values)."""

    def __repr__(self) -> str:
        return "<database url>"


class _World(dict[str, Any]):
    def __repr__(self) -> str:
        return "<world>"


def _sql(url: str, query: str, *args: Any) -> list[tuple[Any, ...]]:
    with psycopg.connect(url, autocommit=True) as conn:
        cur = conn.execute(query, args)
        return cur.fetchall() if cur.description else []


def _user(url: str, name: str, role: str = "user") -> uuid.UUID:
    uid = uuid.uuid4()
    _sql(
        url,
        "INSERT INTO users (id, email, password_hash, role, email_verified_at) "
        "VALUES (%s, %s, 'x', %s, now())",
        uid,
        f"{name}@example.test",
        role,
    )
    _sql(url, "INSERT INTO profiles (id, username, role) VALUES (%s, %s, %s)", uid, name, role)
    return uid


@pytest.fixture(scope="module")
def world() -> Iterator[dict[str, Any]]:
    suffix = secrets.token_hex(3)
    owner = admin_url()
    with scratch_database("core") as raw_url:
        url = _Url(raw_url)
        alembic_upgrade(url)
        app_login = ensure_login(
            owner, "ricotdin_app", f"ricotdin_test_api_{suffix}", connection_limit=5
        )
        svc_login = ensure_login(
            owner, "ricotdin_service", f"ricotdin_test_svc_{suffix}", connection_limit=5
        )
        try:
            w = _World(db=_Url(url), app=_Url(app_login.url(url)), svc=_Url(svc_login.url(url)))
            tag = secrets.token_hex(2)
            for key in "abcde":
                w[key] = _user(url, f"{key}user{tag}", "admin" if key == "e" else "user")
            w["names"] = {key: f"{key}user{tag}" for key in "abcde"}
            w["f1"] = _sql(
                url,
                "INSERT INTO folders (user_id, name, position) VALUES (%s, 'Team', 0) RETURNING id",
                w["a"],
            )[0][0]
            _sql(
                url,
                "INSERT INTO folder_shares (folder_id, user_id, role, invited_by) VALUES "
                "(%s, %s, 'editor', %s), (%s, %s, 'viewer', %s)",
                w["f1"], w["b"], w["a"], w["f1"], w["c"], w["a"],
            )  # fmt: skip
            w["fc"] = _sql(
                url,
                "INSERT INTO folders (user_id, name) VALUES (%s, 'C private') RETURNING id",
                w["c"],
            )[0][0]
            w["m1"], w["m2"], w["m3"] = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
            _sql(
                url,
                "INSERT INTO meetings (id, user_id, title, status, audio_path, folder_id) VALUES "
                "(%s, %s, 'M1', 'done', %s, %s), (%s, %s, 'M2', 'done', %s, %s), "
                "(%s, %s, 'M3 no audio', 'done', NULL, NULL)",
                w["m1"], w["a"], f"{w['a']}/{w['m1']}.webm", w["f1"],
                w["m2"], w["b"], f"{w['b']}/{w['m2']}.webm", w["f1"],
                w["m3"], w["a"],
            )  # fmt: skip
            _sql(
                url,
                "INSERT INTO transcript_segments (meeting_id, segment_index, speaker, start_ms, "
                "end_ms, text, confidence) VALUES (%s, 0, 'S1', 0, 1000, 'hello', 0.95)",
                w["m1"],
            )
            w["todo"] = _sql(
                url,
                "INSERT INTO todos (meeting_id, content) VALUES (%s, 'Ship it') RETURNING id",
                w["m1"],
            )[0][0]
            w["cal"] = _sql(
                url,
                "INSERT INTO calendar_suggestions (meeting_id, title, proposed_at, raw_mention) "
                "VALUES (%s, 'Sprint review', '2026-11-05T09:00:00Z', 'next Thursday') RETURNING id",
                w["m1"],
            )[0][0]
            w["cal_no_time"] = _sql(
                url,
                "INSERT INTO calendar_suggestions (meeting_id, title) VALUES (%s, 'Sometime') "
                "RETURNING id",
                w["m1"],
            )[0][0]
            _sql(
                url,
                "INSERT INTO quota_wallets (user_id, audio_seconds_remaining, "
                "agent_queries_remaining) VALUES (%s, 3600, 50)",
                w["a"],
            )
            yield w
        finally:
            drop_login(owner, app_login.name)
            drop_login(owner, svc_login.name)


@pytest.fixture(scope="module")
def client(world: dict[str, Any]) -> Iterator[TestClient]:
    settings = Settings.model_validate(
        {
            "DATABASE_URL_APP": world["app"],
            "DATABASE_URL_SERVICE": world["svc"],
            "JWT_PRIVATE_KEY": generate_private_pem(),
            "WEB_ORIGIN": WEB,
        }
    )
    settings.db_pool_app = (2, 0)
    settings.db_pool_service = (2, 0)
    app = create_app(settings)
    with TestClient(app, base_url="https://api.ricotdin.test") as c:
        keys = app.state.auth.keys
        roles = {key: "admin" if key == "e" else "user" for key in "abcde"}
        c.headers_for = {  # type: ignore[attr-defined]
            key: {"Authorization": f"Bearer {issue_access_token(keys, world[key], roles[key])}"}
            for key in "abcde"
        }
        yield c


def _as(client: TestClient, who: str) -> dict[str, str]:
    return client.headers_for[who]  # type: ignore[attr-defined, no-any-return]


def _status(client: TestClient, who: str, method: str, path: str, **kw: Any) -> int:
    return client.request(method, path, headers=_as(client, who), **kw).status_code


def _msg(resp: Any) -> str:
    return str(resp.json()["error"]["message"])


# --- auth -------------------------------------------------------------------------------------


def test_requires_a_token(client: TestClient, world: dict[str, Any]) -> None:
    assert client.get("/meetings").status_code == 401
    assert client.get(f"/meetings/{world['m1']}").status_code == 401
    assert client.post("/activity", json={}).status_code == 401


# --- meeting reads (RLS) ----------------------------------------------------------------------


def test_meeting_reads_follow_rls(client: TestClient, world: dict[str, Any]) -> None:
    m1 = world["m1"]
    for who in "abc":
        assert _status(client, who, "GET", f"/meetings/{m1}") == 200, who
        assert _status(client, who, "GET", f"/meetings/{m1}/transcript") == 200, who
    for who in "de":  # stranger and admin without a share
        assert _status(client, who, "GET", f"/meetings/{m1}") == 404, who
        assert _status(client, who, "GET", f"/meetings/{m1}/todos") == 404, who
    assert _status(client, "a", "GET", "/meetings/not-a-uuid") == 404
    assert _status(client, "a", "GET", f"/meetings/{uuid.uuid4()}") == 404
    seg = client.get(f"/meetings/{m1}/transcript", headers=_as(client, "c")).json()["segments"]
    assert [s["text"] for s in seg] == ["hello"]
    assert seg[0]["confidence"] == 0.95  # a number, not a JSON string
    todos = client.get(f"/meetings/{m1}/todos", headers=_as(client, "c")).json()["todos"]
    assert [t["content"] for t in todos] == ["Ship it"]
    cal = client.get(f"/meetings/{m1}/calendar-suggestions", headers=_as(client, "b")).json()
    assert len(cal["suggestions"]) == 2


def test_meeting_list(client: TestClient, world: dict[str, Any]) -> None:
    def ids(who: str, query: str = "") -> set[str]:
        r = client.get(f"/meetings{query}", headers=_as(client, who))
        assert r.status_code == 200
        return {m["id"] for m in r.json()["meetings"]}

    m1, m2, m3 = str(world["m1"]), str(world["m2"]), str(world["m3"])
    assert ids("a") >= {m1, m2, m3}
    assert ids("c") == {m1, m2}
    assert ids("d") == set()
    assert ids("e") == set()
    assert ids("a", f"?folderId={world['f1']}") == {m1, m2}
    assert ids("a", "?folderId=nope") == set()


# --- meeting writes ---------------------------------------------------------------------------


def test_rename_matrix(client: TestClient, world: dict[str, Any]) -> None:
    m1, m2 = world["m1"], world["m2"]
    body = {"json": {"title": "Renamed"}}
    assert _status(client, "a", "PATCH", f"/meetings/{m1}", **body) == 200
    assert _status(client, "b", "PATCH", f"/meetings/{m1}", **body) == 200
    for who in "cde":
        assert _status(client, who, "PATCH", f"/meetings/{m1}", **body) == 403, who
    assert _status(client, "a", "PATCH", f"/meetings/{m2}", **body) == 200  # folder owner
    assert _status(client, "a", "PATCH", f"/meetings/{uuid.uuid4()}", **body) == 404
    r = client.patch(f"/meetings/{m1}", headers=_as(client, "a"), json={"title": " x "})
    assert r.json() == {"ok": True, "title": "x"}


def test_rename_validation_before_access(client: TestClient, world: dict[str, Any]) -> None:
    path = f"/meetings/{world['m1']}"
    r = client.patch(path, headers=_as(client, "d"), json={})
    assert (r.status_code, _msg(r)) == (422, "No updatable fields provided.")
    r = client.patch(path, headers=_as(client, "a"), content=b"{bad")
    assert (r.status_code, _msg(r)) == (400, "Invalid JSON body.")
    r = client.patch(path, headers=_as(client, "a"), content=b"null")
    assert r.status_code == 400  # v1: unhandled 500


def test_move_to_folder(client: TestClient, world: dict[str, Any]) -> None:
    m1 = world["m1"]
    # B edits M1 but only the meeting owner may move it (owner decision 2026-11-02, CWE-269)
    for dest in (str(world["fc"]), str(world["f1"]), None):
        r = client.patch(f"/meetings/{m1}", headers=_as(client, "b"), json={"folder_id": dest})
        assert (r.status_code, _msg(r)) == (
            403,
            "Only the meeting owner can move it to another folder.",
        ), dest
    # ... B still renames it (editor)
    r = client.patch(f"/meetings/{m1}", headers=_as(client, "b"), json={"title": "M1"})
    assert r.status_code == 200
    # A owns M1 but is not editor of C's private folder
    r = client.patch(
        f"/meetings/{m1}", headers=_as(client, "a"), json={"folder_id": str(world["fc"])}
    )
    assert (r.status_code, _msg(r)) == (404, "Folder not found.")
    r = client.patch(f"/meetings/{m1}", headers=_as(client, "a"), json={"folder_id": None})
    assert r.json() == {"ok": True, "folder_id": None}
    r = client.patch(
        f"/meetings/{m1}", headers=_as(client, "a"), json={"folder_id": str(world["f1"])}
    )
    assert r.json() == {"ok": True, "folder_id": str(world["f1"])}


def test_pin_is_meeting_owner_only(client: TestClient, world: dict[str, Any]) -> None:
    m1, m2 = world["m1"], world["m2"]
    for who in "bcde":
        assert _status(client, who, "PATCH", f"/meetings/{m1}/pin") == 403, who
    assert _status(client, "a", "PATCH", f"/meetings/{m2}/pin") == 403  # folder owner too
    assert _status(client, "a", "PATCH", "/meetings/not-a-uuid/pin") == 404  # v1: 500
    first = client.patch(f"/meetings/{m1}/pin", headers=_as(client, "a")).json()
    assert first["ok"] is True and first["pinned_at"] is not None
    second = client.patch(f"/meetings/{m1}/pin", headers=_as(client, "a")).json()
    assert second == {"ok": True, "pinned_at": None}


def test_process_queues_a_job(client: TestClient, world: dict[str, Any]) -> None:
    m1 = world["m1"]
    for who in "bcd":
        assert _status(client, who, "POST", f"/meetings/{m1}/process") == 403, who
    before = _sql(world["db"], "SELECT count(*) FROM jobs WHERE meeting_id = %s", m1)[0][0]
    r = client.post(f"/meetings/{m1}/process", headers=_as(client, "a"))
    assert r.status_code == 202
    assert r.json() == {"ok": True, "meetingId": str(m1), "status": "processing"}
    rows = _sql(
        world["db"],
        "SELECT step, status, payload::text FROM jobs WHERE meeting_id = %s ORDER BY created_at",
        m1,
    )
    assert len(rows) == before + 1 and rows[-1] == ("start", "queued", "{}")
    # ARC-08: one queued/running job per meeting — a repeat queues nothing (still 202).
    again = client.post(f"/meetings/{m1}/process", headers=_as(client, "a"))
    assert again.status_code == 202 and again.json() == r.json()
    count = _sql(world["db"], "SELECT count(*) FROM jobs WHERE meeting_id = %s", m1)[0][0]
    assert count == before + 1
    _sql(world["db"], "UPDATE jobs SET status = 'failed' WHERE meeting_id = %s", m1)
    assert _status(client, "a", "POST", f"/meetings/{m1}/process") == 202  # requeue after failure
    count = _sql(world["db"], "SELECT count(*) FROM jobs WHERE meeting_id = %s", m1)[0][0]
    assert count == before + 2
    assert _status(client, "a", "POST", f"/meetings/{world['m2']}/process") == 403  # folder owner
    r = client.post(f"/meetings/{world['m3']}/process", headers=_as(client, "a"))
    assert r.status_code == 409 and "has no audio" in _msg(r)


def test_process_is_rate_limited_per_user(client: TestClient, world: dict[str, Any]) -> None:
    app: Any = client.app
    saved = app.state.process_limiter
    app.state.process_limiter = RateLimiter(capacity=1, refill_per_second=1 / 3600)
    try:
        _sql(world["db"], "UPDATE jobs SET status = 'failed' WHERE meeting_id = %s", world["m1"])
        assert _status(client, "a", "POST", f"/meetings/{world['m1']}/process") == 202
        assert _status(client, "a", "POST", f"/meetings/{world['m1']}/process") == 429
        assert _status(client, "b", "POST", f"/meetings/{world['m1']}/process") == 403  # own bucket
    finally:
        app.state.process_limiter = saved


# --- todos / calendar -------------------------------------------------------------------------


def test_todo_matrix(client: TestClient, world: dict[str, Any]) -> None:
    path = f"/todos/{world['todo']}"
    ok = {"json": {"status": "done"}}
    assert _status(client, "a", "PATCH", path, **ok) == 200
    assert _status(client, "b", "PATCH", path, **ok) == 200
    for who in "cde":
        assert _status(client, who, "PATCH", path, **ok) == 403, who
    assert _status(client, "a", "PATCH", f"/todos/{uuid.uuid4()}", **ok) == 404
    r = client.patch(path, headers=_as(client, "d"), json={"status": "nope"})
    assert (r.status_code, _msg(r)) == (422, "status must be one of: open, done, dismissed.")
    assert (
        _sql(world["db"], "SELECT status FROM todos WHERE id = %s", world["todo"])[0][0] == "done"
    )


def test_calendar_dismiss_and_ics(client: TestClient, world: dict[str, Any]) -> None:
    cal = world["cal"]
    assert (
        _status(client, "c", "PATCH", f"/calendar-suggestions/{cal}", json={"dismissed": True})
        == 403
    )
    assert (
        _status(client, "b", "PATCH", f"/calendar-suggestions/{cal}", json={"dismissed": True})
        == 200
    )
    r = client.patch(
        f"/calendar-suggestions/{cal}", headers=_as(client, "b"), json={"dismissed": False}
    )
    assert (r.status_code, _msg(r)) == (422, "dismissed must be true.")
    r = client.get(f"/calendar-suggestions/{cal}/ics", headers=_as(client, "c"))
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/calendar")
    assert r.headers["content-disposition"] == 'attachment; filename="sprint-review.ics"'
    assert "DTSTART:20261105T090000Z" in r.text and r.text.startswith("BEGIN:VCALENDAR\r\n")
    for who in "de":
        assert _status(client, who, "GET", f"/calendar-suggestions/{cal}/ics") == 403, who
    assert r.headers["cache-control"] == "no-store"
    odd = _sql(
        world["db"],
        "INSERT INTO calendar_suggestions (meeting_id, title, proposed_at) "
        "VALUES (%s, 'İstanbul ſync', now()) RETURNING id",
        world["m1"],
    )[0][0]
    r = client.get(f"/calendar-suggestions/{odd}/ics", headers=_as(client, "c"))
    assert r.status_code == 200  # was a 500: non-latin-1 header
    assert r.headers["content-disposition"] == 'attachment; filename="stanbul-ync.ics"'
    r = client.get(f"/calendar-suggestions/{world['cal_no_time']}/ics", headers=_as(client, "c"))
    assert r.status_code == 422 and "no specific date/time" in _msg(r)
    assert _status(client, "a", "GET", f"/calendar-suggestions/{uuid.uuid4()}/ics") == 404


# --- folders ----------------------------------------------------------------------------------


def test_folder_list_owned_and_shared(client: TestClient, world: dict[str, Any]) -> None:
    f1 = str(world["f1"])
    mine = client.get("/folders", headers=_as(client, "a")).json()["folders"]
    team = next(f for f in mine if f["id"] == f1)
    assert (team["myRole"], team["memberCount"], team["ownerUsername"]) == ("owner", 2, None)
    shared = client.get("/folders", headers=_as(client, "b")).json()["folders"]
    team = next(f for f in shared if f["id"] == f1)  # works despite the folders_select bug
    assert (team["myRole"], team["ownerUsername"]) == ("editor", world["names"]["a"])
    assert client.get("/folders", headers=_as(client, "d")).json() == {"folders": []}


def test_folder_create_rename_delete(client: TestClient, world: dict[str, Any]) -> None:
    r = client.post("/folders", headers=_as(client, "d"), json={"name": "  Ideas "})
    assert r.status_code == 201
    folder = r.json()["folder"]
    assert (folder["name"], folder["myRole"], folder["memberCount"]) == ("Ideas", "owner", 0)
    r = client.post("/folders", headers=_as(client, "d"), json={"name": "IDEAS"})
    assert (r.status_code, _msg(r)) == (409, 'A folder named "IDEAS" already exists.')
    r = client.post("/folders", headers=_as(client, "d"), content=b"{")
    assert (r.status_code, _msg(r)) == (400, "Invalid JSON.")
    r = client.post("/folders", headers=_as(client, "d"), json={"name": 5})
    assert (r.status_code, _msg(r)) == (400, "name is required.")
    fid = folder["id"]
    assert _status(client, "a", "PATCH", f"/folders/{fid}", json={"name": "x"}) == 404
    r = client.patch(f"/folders/{fid}", headers=_as(client, "d"), json={"name": "Ideas 2"})
    assert r.status_code == 200 and r.json()["folder"]["name"] == "Ideas 2"
    assert _status(client, "a", "DELETE", f"/folders/{fid}") == 404
    # empty folder: nothing to remove from storage (ARC-07 part 2)
    assert _status(client, "d", "DELETE", f"/folders/{fid}?deleteMeetings=true") == 200
    assert _status(client, "d", "DELETE", f"/folders/{fid}") == 404


def test_folder_delete_keeps_everyones_meetings(client: TestClient, world: dict[str, Any]) -> None:
    fid = _sql(
        world["db"],
        "INSERT INTO folders (user_id, name) VALUES (%s, 'Tmp') RETURNING id",
        world["d"],
    )[0][0]
    mid = uuid.uuid4()
    _sql(
        world["db"],
        "INSERT INTO meetings (id, user_id, title, status, folder_id) VALUES (%s, %s, 'T', 'done', %s)",
        mid, world["d"], fid,
    )  # fmt: skip
    assert _status(client, "d", "DELETE", f"/folders/{fid}") == 200
    assert _sql(world["db"], "SELECT folder_id FROM meetings WHERE id = %s", mid) == [(None,)]


def test_reorder(client: TestClient, world: dict[str, Any]) -> None:
    ids = [
        _sql(
            world["db"],
            "INSERT INTO folders (user_id, name) VALUES (%s, %s) RETURNING id",
            world["e"],
            n,
        )[0][0]
        for n in ("one", "two")
    ]
    order = [str(ids[1]), str(world["f1"]), "junk", 7, str(ids[0])]  # f1 is not E's: skipped
    assert client.put(
        "/folders/reorder", headers=_as(client, "e"), json={"order": order}
    ).json() == {"ok": True}
    got = dict(_sql(world["db"], "SELECT id, position FROM folders WHERE user_id = %s", world["e"]))
    assert (got[ids[1]], got[ids[0]]) == (0, 3)
    assert _sql(world["db"], "SELECT position FROM folders WHERE id = %s", world["f1"]) == [(0,)]
    r = client.put("/folders/reorder", headers=_as(client, "e"), json={"order": "x"})
    assert (r.status_code, _msg(r)) == (400, "order must be an array of folder IDs.")


# --- shares + lookup --------------------------------------------------------------------------


def test_share_routes(client: TestClient, world: dict[str, Any]) -> None:
    f1 = world["f1"]
    path = f"/folders/{f1}/shares"
    assert _status(client, "b", "GET", path) == 403
    assert _status(client, "a", "GET", f"/folders/{uuid.uuid4()}/shares") == 404
    members = client.get(path, headers=_as(client, "a")).json()["members"]
    assert {(m["username"], m["role"]) for m in members} == {
        (world["names"]["b"], "editor"),
        (world["names"]["c"], "viewer"),
    }
    d_name = world["names"]["d"]
    r = client.post(path, headers=_as(client, "b"), json={"identifier": d_name, "role": "viewer"})
    assert r.status_code == 403
    r = client.post(
        path, headers=_as(client, "a"), json={"identifier": f"@{d_name.upper()}x", "role": "viewer"}
    )
    assert (r.status_code, _msg(r)) == (404, "No account found with that email.")
    r = client.post(path, headers=_as(client, "a"), json={"identifier": "nobody", "role": "viewer"})
    assert (r.status_code, _msg(r)) == (404, "No account found with that username.")
    r = client.post(
        path, headers=_as(client, "a"), json={"identifier": world["names"]["a"], "role": "viewer"}
    )
    assert (r.status_code, _msg(r)) == (409, "You cannot share a folder with yourself.")
    r = client.post(
        path,
        headers=_as(client, "a"),
        json={"identifier": f"{d_name.upper()}@Example.test", "role": "viewer"},
    )
    assert r.status_code == 201
    assert r.json() == {"member": {"userId": str(world["d"]), "username": d_name, "role": "viewer"}}
    assert "example.test" not in r.text
    r = client.post(path, headers=_as(client, "a"), json={"identifier": d_name, "role": "editor"})
    assert (r.status_code, _msg(r)) == (409, "That user is already a member of this folder.")
    # D now sees M1; promote, then D leaves
    assert _status(client, "d", "GET", f"/meetings/{world['m1']}") == 200
    member = f"{path}/{world['d']}"
    r = client.patch(member, headers=_as(client, "a"), json={"role": "editor"})
    assert r.json() == {"ok": True, "role": "editor"}
    assert _status(client, "c", "PATCH", member, json={"role": "viewer"}) == 403
    assert _status(client, "c", "DELETE", member) == 403
    assert _status(client, "d", "DELETE", member) == 200
    assert _status(client, "d", "GET", f"/meetings/{world['m1']}") == 404


def test_lookup(client: TestClient, world: dict[str, Any]) -> None:
    name = world["names"]["c"]
    r = client.post(
        "/users/lookup", headers=_as(client, "d"), json={"identifier": f"{name}@example.test"}
    )
    assert r.json() == {"id": str(world["c"]), "username": name}
    r = client.post("/users/lookup", headers=_as(client, "d"), json={"identifier": name.upper()})
    assert r.json() == {"id": str(world["c"]), "username": name}
    r = client.post(
        "/users/lookup", headers=_as(client, "d"), json={"identifier": "ghost@example.test"}
    )
    assert (r.status_code, _msg(r)) == (404, "No account found with that email.")
    r = client.post("/users/lookup", headers=_as(client, "d"), json={"identifier": ""})
    assert (r.status_code, _msg(r)) == (422, "identifier is required.")
    app: Any = client.app
    assert app.state.lookup_limiter.capacity == 20  # the policy: 20 per user per 15 minutes
    saved = app.state.lookup_limiter
    app.state.lookup_limiter = RateLimiter(capacity=1, refill_per_second=1e-6)
    try:
        body = {"identifier": name}
        assert client.post("/users/lookup", headers=_as(client, "d"), json=body).status_code == 200
        assert client.post("/users/lookup", headers=_as(client, "d"), json=body).status_code == 429
    finally:
        app.state.lookup_limiter = saved


# --- profile ----------------------------------------------------------------------------------


def test_profile_get(client: TestClient, world: dict[str, Any]) -> None:
    r = client.get("/profile", headers=_as(client, "a"))
    assert r.status_code == 200
    body = r.json()
    assert body["username"] == world["names"]["a"]
    assert body["email"] == f"{world['names']['a']}@example.test"
    assert (body["audio_seconds_remaining"], body["agent_queries_remaining"]) == (3600, 50)
    assert body["meeting_count"] >= 2 and body["folder_count"] >= 1
    assert body["avatar_url"] is None
    other = client.get("/profile", headers=_as(client, "b")).json()
    assert (other["audio_seconds_remaining"], other["agent_queries_remaining"]) == (0, 0)


def test_profile_patch(client: TestClient, world: dict[str, Any]) -> None:
    r = client.patch("/profile", headers=_as(client, "c"), json={"username": world["names"]["a"]})
    assert (r.status_code, _msg(r)) == (409, "Username is already taken.")
    r = client.patch("/profile", headers=_as(client, "c"), json={"role": "admin"})
    assert (r.status_code, _msg(r)) == (400, "No updatable fields provided.")
    r = client.patch(
        "/profile",
        headers=_as(client, "c"),
        json={"display_name": "Cee", "theme_preference": "playful", "role": "admin"},
    )
    assert r.json() == {"ok": True}
    row = _sql(
        world["db"],
        "SELECT display_name, theme_preference, role FROM profiles WHERE id = %s",
        world["c"],
    )
    assert row == [("Cee", "playful", "user")]
    new = world["names"]["c"] + "z"
    assert (
        client.patch(
            "/profile", headers=_as(client, "c"), json={"username": new.upper()}
        ).status_code
        == 200
    )
    world["names"]["c"] = new
    assert _sql(world["db"], "SELECT username FROM profiles WHERE id = %s", world["c"]) == [(new,)]


def test_preferences(client: TestClient, world: dict[str, Any]) -> None:
    r = client.get("/profile/preferences", headers=_as(client, "b"))
    body = r.json()
    assert body["provider"] is None and body["model"] is None
    assert {
        "provider": "gemini",
        "model": "gemini-2.5-flash",
        "label": "Gemini — gemini-2.5-flash",
    } in body["allowedModels"]
    allowed = {(m["provider"], m["model"]) for m in body["allowedModels"]}
    pick = sorted(allowed)[0]
    r = client.patch(
        "/profile/preferences",
        headers=_as(client, "b"),
        json={"provider": pick[0], "model": pick[1]},
    )
    assert r.json() == {"ok": True}
    assert _sql(
        world["db"],
        "SELECT default_provider, default_model FROM profiles WHERE id = %s",
        world["b"],
    ) == [pick]
    r = client.patch(
        "/profile/preferences",
        headers=_as(client, "b"),
        json={"provider": "openai", "model": "gpt-9"},
    )
    assert (r.status_code, _msg(r)) == (400, "openai:gpt-9 is not in the current allow-list.")
    r = client.patch(
        "/profile/preferences", headers=_as(client, "b"), json={"provider": None, "model": None}
    )
    assert r.json() == {"ok": True}
    assert _sql(world["db"], "SELECT default_provider FROM profiles WHERE id = %s", world["b"]) == [
        (None,)
    ]


# --- activity ---------------------------------------------------------------------------------


def test_activity(client: TestClient, world: dict[str, Any]) -> None:
    me = str(world["e"])
    r = client.post(
        "/activity", headers=_as(client, "e"), json={"eventType": "login", "userId": me}
    )
    assert r.status_code == 422
    r = client.post(
        "/activity",
        headers=_as(client, "e"),
        json={"eventType": "record_start", "userId": str(world["a"])},
    )
    assert (r.status_code, _msg(r)) == (403, "Forbidden: userId must match the authenticated user.")
    seen = {"eventType": "record_stop", "userId": str(world["c"]), "meetingId": str(world["m1"])}
    assert client.post("/activity", headers=_as(client, "c"), json=seen).status_code == 200
    hidden = {"eventType": "record_stop", "userId": me, "meetingId": str(world["m1"])}
    assert client.post("/activity", headers=_as(client, "e"), json=hidden).status_code == 200
    rows = _sql(
        world["db"],
        "SELECT user_id, meeting_id FROM activity_log WHERE event_type = 'record_stop'",
    )
    assert (world["c"], world["m1"]) in rows  # viewer: kept
    assert (world["e"], None) in rows  # cannot see M1: stored as NULL
    ok = {"eventType": "record_start", "userId": me, "meetingId": str(uuid.uuid4())}
    app: Any = client.app
    assert app.state.activity_limiter.capacity == 10  # the policy: 10 per user per minute
    app.state.activity_limiter = RateLimiter(capacity=10, refill_per_second=1e-6)  # no refill
    for _ in range(10):
        assert client.post("/activity", headers=_as(client, "e"), json=ok).status_code == 200
    r = client.post("/activity", headers=_as(client, "e"), json=ok)
    assert (r.status_code, _msg(r)) == (429, "Too many activity events. Slow down.")
    rows = _sql(
        world["db"],
        "SELECT event_type, meeting_id FROM activity_log WHERE user_id = %s AND event_type = 'record_start'",
        world["e"],
    )
    assert len(rows) == 10 and all(m is None for _, m in rows)  # unknown meeting id → NULL
