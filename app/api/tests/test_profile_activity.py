"""PRF-09: the caller's own activity feed (pure parts: filters, row shaping)."""

import uuid
from datetime import UTC, datetime

import pytest

from app.core.errors import BadRequest
from app.domain.activity import (
    EVENT_TYPES,
    SHARE_EVENTS,
    OwnActivityFilters,
    own_activity_row,
    parse_own_activity_filters,
    share_metadata,
)

ME = uuid.UUID("00000000-0000-0000-0000-00000000000a")
OTHER = uuid.UUID("00000000-0000-0000-0000-00000000000b")
AT = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)


def _row(**over: object) -> dict[str, object]:
    base: dict[str, object] = {
        "id": uuid.UUID("00000000-0000-0000-0000-000000000001"),
        "created_at": AT,
        "user_id": ME,
        "target_user_id": None,
        "event_type": "meeting_created",
        "meeting_id": None,
        "meeting_title": None,
        "metadata": None,
        "ip": "203.0.113.7",
        "user_agent": "Mozilla/5.0",
        "actor_username": "me",
        "target_username": None,
    }
    return {**base, **over}


# --- filters ---------------------------------------------------------------------------------------


def test_defaults() -> None:
    assert parse_own_activity_filters({}) == OwnActivityFilters(
        page=1, per_page=20, event_type=None
    )


def test_page_per_page_and_type() -> None:
    f = parse_own_activity_filters({"page": "3", "perPage": "50", "eventType": "folder_shared"})
    assert f == OwnActivityFilters(page=3, per_page=50, event_type="folder_shared")


@pytest.mark.parametrize(
    "query",
    [
        {"page": "0"},
        {"page": "x"},
        {"page": "10001"},
        {"perPage": "0"},
        {"perPage": "51"},
        {"perPage": "1.5"},
        {"eventType": "login"},
        {"eventType": "nope"},
    ],
)
def test_bad_values_are_400(query: dict[str, str]) -> None:
    with pytest.raises(BadRequest):
        parse_own_activity_filters(query)


def test_empty_event_type_means_all() -> None:
    assert parse_own_activity_filters({"eventType": ""}).event_type is None


def test_known_events() -> None:
    assert set(SHARE_EVENTS) == {"folder_shared", "folder_unshared"}
    assert set(SHARE_EVENTS) <= set(EVENT_TYPES)
    assert "meeting_created" in EVENT_TYPES and "login" not in EVENT_TYPES


# --- rows ------------------------------------------------------------------------------------------


def test_own_row_keeps_ip_and_device() -> None:
    out = own_activity_row(_row(meeting_id=OTHER, meeting_title="Weekly"), ME)
    assert out == {
        "id": "00000000-0000-0000-0000-000000000001",
        "createdAt": AT,
        "eventType": "meeting_created",
        "direction": "out",
        "meetingId": str(OTHER),
        "meetingTitle": "Weekly",
        "folderName": None,
        "role": None,
        "otherUser": None,
        "left": False,
        "ip": "203.0.113.7",
        "userAgent": "Mozilla/5.0",
    }


def test_an_incoming_share_never_shows_the_actors_ip_or_device() -> None:
    row = _row(
        user_id=OTHER,
        target_user_id=ME,
        event_type="folder_shared",
        actor_username="alice",
        target_username="me",
        metadata={"folder_id": "f", "folder_name": "Sales", "role": "editor"},
    )
    out = own_activity_row(row, ME)
    assert out["direction"] == "in"
    assert out["ip"] is None and out["userAgent"] is None
    assert out["otherUser"] == "alice"
    assert (out["folderName"], out["role"]) == ("Sales", "editor")


def test_an_outgoing_share_names_the_grantee() -> None:
    row = _row(
        event_type="folder_unshared",
        target_user_id=OTHER,
        target_username="bob",
        metadata={"folder_id": "f", "folder_name": "Sales", "left": True},
    )
    out = own_activity_row(row, ME)
    assert (out["direction"], out["otherUser"], out["left"]) == ("out", "bob", True)


def test_a_deleted_meeting_shows_its_stored_title() -> None:
    row = _row(event_type="meeting_deleted", metadata={"meeting_id": "x", "title": "Old"})
    assert own_activity_row(row, ME)["meetingTitle"] == "Old"


def test_metadata_of_the_wrong_shape_is_ignored() -> None:
    row = _row(event_type="folder_shared", metadata={"folder_name": 5, "role": ["x"], "left": "y"})
    out = own_activity_row(row, ME)
    assert (out["folderName"], out["role"], out["left"]) == (None, None, False)
    assert own_activity_row(_row(metadata="not json"), ME)["folderName"] is None


def test_a_long_folder_name_is_cut() -> None:
    row = _row(event_type="folder_shared", metadata={"folder_name": "x" * 500})
    assert len(str(own_activity_row(row, ME)["folderName"])) == 200


def test_share_metadata() -> None:
    fid = uuid.uuid4()
    assert share_metadata(fid, "Sales", role="viewer") == {
        "folder_id": str(fid),
        "folder_name": "Sales",
        "role": "viewer",
    }
    assert share_metadata(fid, "Sales", left=True) == {
        "folder_id": str(fid),
        "folder_name": "Sales",
        "left": True,
    }
