# ruff: noqa: F811 - pytest fixtures imported from the core domain tests are parameters here
"""PRF-09: GET /profile/activity end to end (scratch database, the real API): only the caller's
rows and the share rows that target them; never someone else's IP / user agent; a meeting title
only while the caller can still see the meeting; both sides of a folder share are recorded."""

import uuid
from typing import Any

from fastapi.testclient import TestClient

from tests.conftest import requires_db
from tests.test_core_domain_integration import (  # noqa: F401 - fixtures
    _as,
    _sql,
    client,
    world,
)

pytestmark = requires_db

URL = "/profile/activity"


def _feed(client: TestClient, who: str, **params: Any) -> list[dict[str, Any]]:
    r = client.get(URL, headers=_as(client, who), params=params)
    assert r.status_code == 200, r.text
    rows: list[dict[str, Any]] = r.json()["rows"]
    return rows


def _log(world: dict[str, Any], who: str, event: str, **cols: Any) -> None:
    _sql(
        world["db"],
        "INSERT INTO activity_log (user_id, event_type, meeting_id, target_user_id, metadata, ip, "
        "user_agent) VALUES (%s, %s, %s, %s, %s, %s, %s)",
        world[who], event, cols.get("meeting"), cols.get("target"), cols.get("metadata"),
        cols.get("ip"), cols.get("ua"),
    )  # fmt: skip


def test_needs_an_mmlabs_token(client: TestClient) -> None:
    assert client.get(URL).status_code == 401
    assert client.get(URL, headers={"Authorization": "Bearer nope"}).status_code == 401


def test_bad_filters_are_400(client: TestClient) -> None:
    for params in ({"eventType": "login"}, {"perPage": "51"}, {"page": "0"}):
        assert client.get(URL, headers=_as(client, "a"), params=params).status_code == 400


def test_both_sides_of_a_folder_share_are_recorded(
    client: TestClient, world: dict[str, Any]
) -> None:
    a, d = world["names"]["a"], world["names"]["d"]
    r = client.post("/folders", headers=_as(client, "a"), json={"name": "PRF-09 shared"})
    fid = r.json()["folder"]["id"]
    path = f"/folders/{fid}/shares"
    r = client.post(path, headers=_as(client, "a"), json={"identifier": d, "role": "viewer"})
    assert r.status_code == 201, r.text

    [mine] = _feed(client, "a", eventType="folder_shared")
    assert (mine["direction"], mine["otherUser"], mine["folderName"], mine["role"]) == (
        "out", d, "PRF-09 shared", "viewer",
    )  # fmt: skip
    assert mine["userAgent"]  # the caller's own device
    [theirs] = _feed(client, "d", eventType="folder_shared")
    assert (theirs["direction"], theirs["otherUser"], theirs["folderName"]) == (
        "in", a, "PRF-09 shared",
    )  # fmt: skip
    assert theirs["ip"] is None and theirs["userAgent"] is None  # never the owner's

    # D leaves: both see it, marked as a leave
    assert client.delete(f"{path}/{world['d']}", headers=_as(client, "d")).status_code == 200
    [left_a] = _feed(client, "a", eventType="folder_unshared")
    assert (left_a["direction"], left_a["otherUser"], left_a["left"]) == ("in", d, True)
    assert left_a["ip"] is None and left_a["userAgent"] is None
    [left_d] = _feed(client, "d", eventType="folder_unshared")
    assert (left_d["direction"], left_d["otherUser"], left_d["left"]) == ("out", a, True)

    # A shares again and removes D
    client.post(path, headers=_as(client, "a"), json={"identifier": d, "role": "editor"})
    assert client.delete(f"{path}/{world['d']}", headers=_as(client, "a")).status_code == 200
    removed = _feed(client, "d", eventType="folder_unshared")[0]
    assert (removed["direction"], removed["otherUser"], removed["left"]) == ("in", a, False)


def test_never_someone_elses_rows(client: TestClient, world: dict[str, Any]) -> None:
    _log(world, "b", "record_start", ip="198.51.100.9", ua="B-secret-agent")
    _log(world, "b", "folder_shared", target=world["c"], ip="198.51.100.9", ua="B-secret-agent",
         metadata='{"folder_name": "B stuff", "role": "viewer"}')  # fmt: skip
    for who in "acd":
        text = client.get(URL, headers=_as(client, who), params={"perPage": "50"}).text
        assert "198.51.100.9" not in text and "B-secret-agent" not in text
    assert all(r["eventType"] != "record_start" for r in _feed(client, "c", perPage="50"))
    [shared] = [r for r in _feed(client, "c", eventType="folder_shared")
                if r["folderName"] == "B stuff"]  # fmt: skip
    assert shared["otherUser"] == world["names"]["b"]
    # a non-share row that merely names C as target is not C's
    _log(world, "b", "chat_message", target=world["c"], ip="198.51.100.9")
    assert all(r["eventType"] != "chat_message" for r in _feed(client, "c", perPage="50"))


def test_a_meeting_title_only_while_the_caller_can_see_it(
    client: TestClient, world: dict[str, Any]
) -> None:
    _log(world, "d", "chat_message", meeting=world["m1"])  # D has no access to M1
    _log(world, "b", "chat_message", meeting=world["m1"])  # B is an editor of folder f1
    [d_row] = _feed(client, "d", eventType="chat_message")
    assert d_row["meetingTitle"] is None and d_row["meetingId"] is None
    b_rows = _feed(client, "b", eventType="chat_message")
    assert any(r["meetingTitle"] == "M1" and r["meetingId"] == str(world["m1"]) for r in b_rows)


def test_paging_is_newest_first(client: TestClient, world: dict[str, Any]) -> None:
    for i in range(3):
        _sql(world["db"], "INSERT INTO activity_log (user_id, event_type, created_at) VALUES "
             "(%s, 'record_stop', now() - make_interval(mins => %s))", world["e"], i)  # fmt: skip
    r = client.get(URL, headers=_as(client, "e"), params={"eventType": "record_stop", "perPage": 2})
    body = r.json()
    assert (body["total"], body["page"], body["perPage"], len(body["rows"])) == (3, 1, 2, 2)
    first = body["rows"][0]["createdAt"]
    page2 = _feed(client, "e", eventType="record_stop", perPage=2, page=2)
    assert len(page2) == 1 and page2[0]["createdAt"] < first


def test_a_deleted_meeting_keeps_its_title(client: TestClient, world: dict[str, Any]) -> None:
    mid = uuid.uuid4()
    _sql(world["db"], "INSERT INTO meetings (id, user_id, title, status) VALUES "
         "(%s, %s, 'Gone soon', 'done')", mid, world["c"])  # fmt: skip
    assert client.delete(f"/meetings/{mid}", headers=_as(client, "c")).status_code == 200
    [row] = _feed(client, "c", eventType="meeting_deleted")
    assert (row["meetingTitle"], row["meetingId"]) == ("Gone soon", None)


def test_meetings_deleted_with_their_folder_keep_their_title(
    client: TestClient, world: dict[str, Any]
) -> None:
    r = client.post("/folders", headers=_as(client, "e"), json={"name": "PRF-09 to delete"})
    fid = r.json()["folder"]["id"]
    _sql(world["db"], "INSERT INTO meetings (id, user_id, title, status, folder_id) VALUES "
         "(%s, %s, 'In the folder', 'done', %s)", uuid.uuid4(), world["e"], fid)  # fmt: skip
    r = client.delete(
        f"/folders/{fid}", headers=_as(client, "e"), params={"deleteMeetings": "true"}
    )
    assert r.status_code == 200, r.text
    titles = [row["meetingTitle"] for row in _feed(client, "e", eventType="meeting_deleted")]
    assert "In the folder" in titles
