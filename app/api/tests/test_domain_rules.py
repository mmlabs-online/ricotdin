"""ARC-07: request validation, ported from the v1 route handlers (same messages and status codes;
cases where v1 crashed with a 500 now get the 400/422 the route intended)."""

import uuid
from typing import Any

import pytest

from app.core.errors import AppError
from app.domain.rules import (
    CLIENT_EVENT_TYPES,
    can_reprocess,
    has_invisible_characters,
    is_email_identifier,
    normalize_lookup_username,
    parse_activity,
    parse_dismissed,
    parse_folder_name,
    parse_lookup,
    parse_meeting_patch,
    parse_preferences,
    parse_profile_patch,
    parse_reorder,
    parse_share_create,
    parse_share_role,
    parse_todo_status,
    parse_uuid,
)

FID = str(uuid.uuid4())


def _fails(fn: Any, *args: Any) -> tuple[int, str]:
    with pytest.raises(AppError) as exc:
        fn(*args)
    return exc.value.status, exc.value.public_message


# --- ids --------------------------------------------------------------------------------------


def test_parse_uuid() -> None:
    assert parse_uuid(FID) == uuid.UUID(FID)
    assert parse_uuid(FID.upper()) == uuid.UUID(FID)
    for bad in ("", "nope", "1234", None, 5):
        assert parse_uuid(bad) is None


# --- meetings ---------------------------------------------------------------------------------


def test_meeting_patch_title_and_folder() -> None:
    assert parse_meeting_patch({"title": "  Weekly  "}) == {"title": "Weekly"}
    assert parse_meeting_patch({"folder_id": None}) == {"folder_id": None}
    assert parse_meeting_patch({"folder_id": FID, "x": 1}) == {"folder_id": uuid.UUID(FID)}


@pytest.mark.parametrize(
    ("body", "status", "message"),
    [
        ({"title": 3}, 422, "title must be a string."),
        ({"title": "   "}, 422, "title must not be empty."),
        ({"title": "a" * 201}, 422, "title must be 200 characters or fewer."),
        ({"folder_id": 3}, 422, "folder_id must be a UUID string or null."),
        ({"folder_id": ""}, 422, "folder_id must be a UUID string or null."),  # v1: 500
        ({"folder_id": "nope"}, 422, "folder_id must be a UUID string or null."),
        ({}, 422, "No updatable fields provided."),
    ],
)
def test_meeting_patch_errors(body: dict[str, Any], status: int, message: str) -> None:
    assert _fails(parse_meeting_patch, body) == (status, message)


def test_meeting_patch_title_200_is_fine() -> None:
    assert parse_meeting_patch({"title": "a" * 200}) == {"title": "a" * 200}


def test_can_reprocess() -> None:
    assert can_reprocess("u/m.webm")
    assert not can_reprocess(None)
    assert not can_reprocess("")


# --- todos / calendar -------------------------------------------------------------------------


@pytest.mark.parametrize("status", ["open", "done", "dismissed"])
def test_todo_status_ok(status: str) -> None:
    assert parse_todo_status({"status": status}) == status


@pytest.mark.parametrize("body", [{}, {"status": "closed"}, {"status": 1}, {"status": ""}])
def test_todo_status_bad(body: dict[str, Any]) -> None:
    assert _fails(parse_todo_status, body) == (422, "status must be one of: open, done, dismissed.")


def test_dismissed_must_be_true() -> None:
    parse_dismissed({"dismissed": True})
    for body in ({}, {"dismissed": False}, {"dismissed": "true"}, {"dismissed": 1}):
        assert _fails(parse_dismissed, body) == (422, "dismissed must be true.")


# --- folders ----------------------------------------------------------------------------------


def test_folder_name() -> None:
    assert parse_folder_name({"name": "  Team  "}) == "Team"
    assert parse_folder_name({"name": "a" * 100}) == "a" * 100


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({}, "name is required."),
        ({"name": "   "}, "name is required."),
        ({"name": 5}, "name is required."),  # v1: 500
        ({"name": "a" * 101}, "Folder name too long (max 100 characters)."),
    ],
)
def test_folder_name_errors(body: dict[str, Any], message: str) -> None:
    assert _fails(parse_folder_name, body) == (400, message)


def test_share_create() -> None:
    assert parse_share_create({"identifier": " Bob ", "role": "editor"}) == ("Bob", "editor")


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({"role": "viewer"}, "identifier is required."),
        ({"identifier": "  ", "role": "viewer"}, "identifier is required."),
        ({"identifier": 3, "role": "viewer"}, "identifier is required."),
        ({"identifier": "bob"}, 'role must be "editor" or "viewer".'),
        ({"identifier": "bob", "role": "owner"}, 'role must be "editor" or "viewer".'),
    ],
)
def test_share_create_errors(body: dict[str, Any], message: str) -> None:
    assert _fails(parse_share_create, body) == (422, message)


def test_share_role() -> None:
    assert parse_share_role({"role": "viewer"}) == "viewer"
    assert _fails(parse_share_role, {"role": "VIEWER"}) == (
        422,
        'role must be "editor" or "viewer".',
    )


def test_reorder_positions_count_every_string() -> None:
    """v1: non-strings are dropped first; positions = index among the strings. A string that is
    not a UUID keeps its slot but matches no folder."""
    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    got = parse_reorder({"order": [a, 3, None, "nope", b]})
    assert got == [(uuid.UUID(a), 0), (uuid.UUID(b), 2)]
    assert parse_reorder({"order": []}) == []


@pytest.mark.parametrize("body", [{}, {"order": "x"}, {"order": {"a": 1}}])
def test_reorder_needs_an_array(body: dict[str, Any]) -> None:
    assert _fails(parse_reorder, body) == (400, "order must be an array of folder IDs.")


# --- lookup -----------------------------------------------------------------------------------


def test_lookup_identifier() -> None:
    assert parse_lookup({"identifier": "  Alice@Example.com "}) == "Alice@Example.com"
    assert _fails(parse_lookup, {"identifier": ""}) == (422, "identifier is required.")
    assert is_email_identifier("a@b.c")
    assert is_email_identifier("@alice")  # v1: any '@' takes the email path
    assert not is_email_identifier("alice")
    assert normalize_lookup_username("  Alice ") == "alice"


# --- profile ----------------------------------------------------------------------------------


def test_profile_patch_fields() -> None:
    assert parse_profile_patch({"username": " Bob_1 "}) == {"username": "bob_1"}
    assert parse_profile_patch({"display_name": ""}) == {"display_name": None}
    assert parse_profile_patch({"display_name": "  Bob  "}) == {"display_name": "  Bob  "}
    assert parse_profile_patch({"theme_preference": None}) == {"theme_preference": None}
    assert parse_profile_patch({"theme_preference": "playful", "role": "admin"}) == {
        "theme_preference": "playful"
    }


@pytest.mark.parametrize(
    ("body", "status", "message"),
    [
        ({"username": 3}, 400, "username must be a string."),
        ({"username": "ab"}, 422, "Username must be at least 3 characters."),
        ({"username": "a" * 31}, 422, "Username must be at most 30 characters."),
        (
            {"username": "bad name"},
            422,
            "Username may only contain lowercase letters, digits, hyphens, and underscores.",
        ),
        ({"display_name": 3}, 400, "display_name must be a string or null."),
        ({"display_name": "a" * 51}, 422, "Display name must be at most 50 characters."),
        (
            {"theme_preference": "dark"},
            422,
            "theme_preference must be one of: luxury, default, playful.",
        ),
        (
            {"theme_preference": ""},
            422,
            "theme_preference must be one of: luxury, default, playful.",
        ),
        ({}, 400, "No updatable fields provided."),
        ({"role": "admin"}, 400, "No updatable fields provided."),
    ],
)
def test_profile_patch_errors(body: dict[str, Any], status: int, message: str) -> None:
    assert _fails(parse_profile_patch, body) == (status, message)


def test_profile_patch_checks_username_first() -> None:
    body = {"username": "ab", "display_name": 3}
    assert _fails(parse_profile_patch, body)[1] == "Username must be at least 3 characters."


# --- preferences ------------------------------------------------------------------------------

ALLOWED = [("gemini", "gemini-2.5-flash"), ("openai", "gpt-4o")]


def test_preferences_set_and_clear() -> None:
    assert parse_preferences({"provider": "openai", "model": "gpt-4o"}, ALLOWED) == (
        "openai",
        "gpt-4o",
    )
    assert parse_preferences({"provider": None, "model": None}, ALLOWED) == (None, None)


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({}, "provider and model must both be strings, or both null."),
        (
            {"provider": "openai", "model": None},
            "provider and model must both be strings, or both null.",
        ),
        (
            {"provider": "openai", "model": 4},
            "provider and model must both be strings, or both null.",
        ),
        (
            {"provider": "openai", "model": "gpt-4o-mini"},
            "openai:gpt-4o-mini is not in the current allow-list.",
        ),
    ],
)
def test_preferences_errors(body: dict[str, Any], message: str) -> None:
    assert _fails(parse_preferences, body, ALLOWED) == (400, message)


# --- activity ---------------------------------------------------------------------------------

ME = uuid.uuid4()


def test_activity_client_events() -> None:
    assert CLIENT_EVENT_TYPES == ("record_start", "record_stop", "recording_notice_ack")
    mid = uuid.uuid4()
    body = {"eventType": "record_start", "userId": str(ME), "meetingId": str(mid)}
    assert parse_activity(body, ME) == ("record_start", mid)
    assert parse_activity({"eventType": "record_stop", "userId": str(ME)}, ME) == (
        "record_stop",
        None,
    )
    # a meetingId that is not a UUID is dropped (v1: the insert failed silently)
    body = {"eventType": "record_stop", "userId": str(ME), "meetingId": "x"}
    assert parse_activity(body, ME) == ("record_stop", None)


@pytest.mark.parametrize("event", ["login", "meeting_created", "meeting_viewed", "", 3])
def test_activity_rejects_server_and_unknown_events(event: Any) -> None:
    body = {"eventType": event, "userId": str(ME)}
    assert _fails(parse_activity, body, ME) == (
        422,
        "eventType must be one of: record_start, record_stop, recording_notice_ack.",
    )


@pytest.mark.parametrize("user_id", [None, "", str(uuid.uuid4()), "not-a-uuid"])
def test_activity_only_for_the_caller(user_id: Any) -> None:
    body = {"eventType": "record_start", "userId": user_id}
    assert _fails(parse_activity, body, ME) == (
        403,
        "Forbidden: userId must match the authenticated user.",
    )


# --- SEC-05: invisible characters in names ----------------------------------------------------

_INVISIBLE = [
    "‪", "‫", "‬", "‭", "‮",  # bidi embeddings / overrides
    "⁦", "⁧", "⁨", "⁩",  # bidi isolates
    "​", "‌", "‍", "‎", "‏",  # zero-width, LRM / RLM
    "⁠", "⁡", "⁢", "⁣", "⁤",  # word joiner, invisible operators
    "﻿",  # zero-width no-break space / BOM
    "\x00", "\t", "\n", "\x1f", "\x7f", "\x85", "\x9f",  # C0 / C1 controls
]  # fmt: skip


@pytest.mark.parametrize("ch", _INVISIBLE)
def test_sec05_invisible_characters_are_detected(ch: str) -> None:
    assert has_invisible_characters(f"Plan{ch}2026")


@pytest.mark.parametrize(
    "name", ["Họp tuần", "Báo cáo Q4 – đội Kỹ thuật", "📌 Sprint", "a-b_c (1)"]
)
def test_sec05_normal_names_pass(name: str) -> None:
    assert not has_invisible_characters(name)
    assert parse_folder_name({"name": name}) == name
    assert parse_meeting_patch({"title": name}) == {"title": name}


@pytest.mark.parametrize("ch", ["‮", "​", "﻿"])
def test_sec05_folder_name_with_invisible_characters_is_refused(ch: str) -> None:
    with pytest.raises(AppError) as exc:
        parse_folder_name({"name": f"Shared{ch}fdp.exe"})
    assert (exc.value.status, exc.value.code) == (400, "invalid_characters")


@pytest.mark.parametrize("ch", ["‮", "⁦", "\x00"])
def test_sec05_meeting_title_with_invisible_characters_is_refused(ch: str) -> None:
    with pytest.raises(AppError) as exc:
        parse_meeting_patch({"title": f"Weekly{ch}sync"})
    assert (exc.value.status, exc.value.code) == (422, "invalid_characters")
