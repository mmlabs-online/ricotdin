"""ARC-07 part 2: pure upload rules (meeting create, uploaded, avatar), ported from the v1 route
handlers (legacy/app/api/meetings/route.ts, meetings/[id]/uploaded, profile/avatar, profile)."""

import uuid
from datetime import UTC, datetime
from typing import Any

import pytest

from app.core.errors import AppError
from app.domain.access import can_move_meeting
from app.domain.uploads import (
    AVATAR_TYPES,
    MAX_AVATAR_BYTES,
    MAX_UPLOAD_BYTES,
    audio_key,
    avatar_key,
    format_meeting_title,
    parse_avatar_patch,
    parse_avatar_request,
    parse_meeting_create,
    parse_uploaded,
    upload_content_type,
)

U = uuid.UUID("11111111-1111-1111-1111-111111111111")
M = uuid.UUID("22222222-2222-2222-2222-222222222222")


def err(fn: Any, *args: Any) -> tuple[int, str]:
    with pytest.raises(AppError) as exc:
        fn(*args)
    return exc.value.status, exc.value.public_message


# --- create -----------------------------------------------------------------------------------


def test_create_defaults_to_a_webm_recording() -> None:
    c = parse_meeting_create({"size": 1000})
    assert (c.ext, c.source, c.content_type, c.size) == (".webm", "recorded", "audio/webm", 1000)
    assert c.duration_seconds is None and c.started_at is None and c.folder_id is None


def test_create_keeps_the_browser_mime_when_it_matches_the_extension() -> None:
    c = parse_meeting_create({"size": 5, "mimeType": "audio/webm;codecs=opus"})
    assert c.content_type == "audio/webm;codecs=opus"
    c = parse_meeting_create({"size": 5, "fileExtension": "MP3", "mimeType": "audio/x-whatever"})
    assert (c.ext, c.content_type) == (".mp3", "audio/mpeg")  # mismatch → type from the extension
    c = parse_meeting_create(
        {"size": 5, "fileExtension": ".m4a", "mimeType": "application/octet-stream"}
    )
    assert c.content_type == "audio/mp4"


@pytest.mark.parametrize(
    ("ext", "source", "ctype"),
    [
        (".mp4", "video", "video/mp4"),
        (".mov", "video", "video/quicktime"),
        (".wav", "uploaded", "audio/wav"),
        (".flac", "uploaded", "audio/flac"),
    ],
)
def test_create_extensions(ext: str, source: str, ctype: str) -> None:
    c = parse_meeting_create({"size": 5, "fileExtension": ext, "source": source})
    assert (c.ext, c.source, c.content_type) == (ext, source, ctype)


def test_create_unknown_source_becomes_recorded() -> None:
    assert parse_meeting_create({"size": 5, "source": "hacker"}).source == "recorded"


def test_create_fields() -> None:
    fid = str(uuid.uuid4())
    c = parse_meeting_create(
        {"size": 5, "durationSeconds": 61, "startedAt": "2026-11-02T08:30:00Z", "folderId": fid}
    )
    assert c.duration_seconds == 61
    assert c.started_at == datetime(2026, 11, 2, 8, 30, tzinfo=UTC)
    assert str(c.folder_id) == fid
    assert parse_meeting_create({"size": 5, "folderId": None}).folder_id is None


@pytest.mark.parametrize(
    ("body", "status", "start"),
    [
        ({"size": 5, "fileExtension": ".exe"}, 400, "Unsupported file extension"),
        ({"size": 5, "fileExtension": 7}, 400, "Unsupported file extension"),
        ({}, 422, "size must be"),
        ({"size": 0}, 422, "size must be"),
        ({"size": "10"}, 422, "size must be"),
        ({"size": True}, 422, "size must be"),
        ({"size": MAX_UPLOAD_BYTES + 1}, 422, "File exceeds the 500 MB upload limit."),
        ({"size": 5, "durationSeconds": -1}, 422, "durationSeconds"),
        ({"size": 5, "durationSeconds": "x"}, 422, "durationSeconds"),
        ({"size": 5, "startedAt": "yesterday"}, 422, "startedAt"),
        ({"size": 5, "folderId": "nope"}, 404, "Folder not found."),
    ],
)
def test_create_errors(body: dict[str, Any], status: int, start: str) -> None:
    got_status, message = err(parse_meeting_create, body)
    assert got_status == status and message.startswith(start), message


def test_upload_content_type_for_a_stored_key() -> None:
    assert upload_content_type(f"{U}/{M}.webm") == "audio/webm"
    assert upload_content_type(f"{U}/{M}.mov") == "video/quicktime"
    assert upload_content_type(f"{U}/{M}") is None
    assert upload_content_type(f"{U}/{M}.exe") is None


def test_keys() -> None:
    assert audio_key(U, M, ".webm") == f"{U}/{M}.webm"
    key = avatar_key(U, "image/png")
    assert key.startswith(f"avatars/{U}/") and key.endswith(".png")
    assert avatar_key(U, "image/jpeg").endswith(".jpg")
    assert avatar_key(U, "image/png") != avatar_key(U, "image/png")


# --- title (Vietnam time, v1's en-US format) ---------------------------------------------------


def test_title_uses_vietnam_time() -> None:
    assert format_meeting_title(datetime(2026, 11, 2, 8, 5, tzinfo=UTC)) == "Nov 2, 2026, 3:05 PM"
    assert format_meeting_title(datetime(2026, 1, 1, 17, 0, tzinfo=UTC)) == "Jan 2, 2026, 12:00 AM"
    assert format_meeting_title(datetime(2026, 1, 1, 5, 0, tzinfo=UTC)) == "Jan 1, 2026, 12:00 PM"


# --- uploaded ---------------------------------------------------------------------------------


def test_uploaded_body() -> None:
    u = parse_uploaded({"fileId": "abcDEF123_-xyz", "size": 42})
    assert (u.file_id, u.size, u.preferred) == ("abcDEF123_-xyz", 42, None)
    u = parse_uploaded(
        {"fileId": "abcDEF123_-xyz", "size": 42, "preferred_provider": "gemini",
         "preferred_model": "gemini-2.5-flash"}
    )  # fmt: skip
    assert u.preferred == ("gemini", "gemini-2.5-flash")
    # only both strings count (v1)
    assert (
        parse_uploaded({"fileId": "abcDEF123_-xyz", "size": 1, "preferred_provider": "g"}).preferred
        is None
    )


@pytest.mark.parametrize(
    ("body", "status"),
    [
        ({"size": 1}, 422),
        ({"fileId": "", "size": 1}, 422),
        ({"fileId": "../x", "size": 1}, 422),
        ({"fileId": "abcDEF123_-xyz"}, 422),
        ({"fileId": "abcDEF123_-xyz", "size": 0}, 422),
        ({"fileId": "abcDEF123_-xyz", "size": MAX_UPLOAD_BYTES + 1}, 422),
    ],
)
def test_uploaded_errors(body: dict[str, Any], status: int) -> None:
    assert err(parse_uploaded, body)[0] == status


# --- avatar -----------------------------------------------------------------------------------


def test_avatar_request() -> None:
    assert parse_avatar_request({"contentType": "image/webp", "size": 10}) == ("image/webp", 10)
    assert set(AVATAR_TYPES) == {"image/jpeg", "image/png", "image/webp"}


@pytest.mark.parametrize(
    ("body", "message"),
    [
        (
            {"contentType": "image/gif", "size": 1},
            "contentType must be one of: image/jpeg, image/png, image/webp.",
        ),
        ({"size": 1}, "contentType must be one of: image/jpeg, image/png, image/webp."),
        ({"contentType": "image/png"}, "size must be a positive number."),
        ({"contentType": "image/png", "size": 0}, "size must be a positive number."),
        (
            {"contentType": "image/png", "size": MAX_AVATAR_BYTES + 1},
            "Avatar must be smaller than 2 MB.",
        ),
    ],
)
def test_avatar_request_errors(body: dict[str, Any], message: str) -> None:
    assert err(parse_avatar_request, body) == (422, message)


def test_avatar_patch() -> None:
    key = f"avatars/{U}/{uuid.uuid4()}.png"
    assert parse_avatar_patch({"username": "x"}, U) is None  # no avatar change
    assert parse_avatar_patch({"avatar_key": None}, U) == (None, None, None)
    got = parse_avatar_patch(
        {"avatar_key": key, "avatar_file_id": "abcDEF123_-xyz", "avatar_size": 9}, U
    )
    assert got == (key, "abcDEF123_-xyz", 9)


@pytest.mark.parametrize(
    ("body", "status", "message"),
    [
        ({"avatar_key": 5}, 400, "avatar_key must be a string or null."),
        ({"avatar_key": "avatars/other/x.png"}, 422, "Invalid avatar_key."),
        ({"avatar_key": f"{U}/{M}.webm"}, 422, "Invalid avatar_key."),  # someone's audio (BUG-002)
    ],
)
def test_avatar_patch_errors(body: dict[str, Any], status: int, message: str) -> None:
    assert err(parse_avatar_patch, body, U) == (status, message)


def test_avatar_patch_needs_the_uploaded_file() -> None:
    key = f"avatars/{U}/{uuid.uuid4()}.png"
    assert err(parse_avatar_patch, {"avatar_key": key}, U)[0] == 422
    assert (
        err(parse_avatar_patch, {"avatar_key": key, "avatar_file_id": "abcDEF123_-xyz"}, U)[0]
        == 422
    )
    big = {
        "avatar_key": key,
        "avatar_file_id": "abcDEF123_-xyz",
        "avatar_size": MAX_AVATAR_BYTES + 1,
    }
    assert err(parse_avatar_patch, big, U)[0] == 422


# --- move (owner decision 2026-11-02) ----------------------------------------------------------


def test_only_the_meeting_owner_moves_a_meeting() -> None:
    other = uuid.uuid4()
    assert can_move_meeting(U, meeting_owner=U)
    assert not can_move_meeting(U, meeting_owner=other)


def test_avatar_content_type() -> None:
    from app.domain.uploads import avatar_content_type

    assert avatar_content_type(f"avatars/{U}/{M}.jpg") == "image/jpeg"
    assert avatar_content_type(f"avatars/{U}/{M}.webp") == "image/webp"
    assert avatar_content_type(f"avatars/{U}/{M}.gif") is None


def test_profile_patch_may_be_avatar_only() -> None:
    from app.domain.rules import parse_profile_patch

    assert parse_profile_patch({"avatar_key": None}, allow_empty=True) == {}
    with pytest.raises(AppError):
        parse_profile_patch({"avatar_key": None})


# --- review round 1 -----------------------------------------------------------------------------


def test_create_empty_folder_id_means_no_folder() -> None:
    assert parse_meeting_create({"size": 5, "folderId": ""}).folder_id is None


@pytest.mark.parametrize(
    "mime",
    [
        "audio/webm\r\nX-Evil: 1",
        "audio/webm;" + "a" * 300,
        "audio/webm; x=é",
        'audio/webm;codecs="opus"\n',
    ],
)
def test_create_drops_an_unsafe_browser_mime(mime: str) -> None:
    assert parse_meeting_create({"size": 5, "mimeType": mime}).content_type == "audio/webm"


def test_arc12_new_uploads_are_capped_at_500_mb_but_stored_audio_reads_keep_1_gb() -> None:
    """Owner decision 2026-11-04: new uploads ≤ 500 MB; v1 files (≤ 1 GB) must still process."""
    from app.domain.uploads import MAX_STORED_AUDIO_BYTES

    assert MAX_UPLOAD_BYTES == 500 * 1024 * 1024
    assert MAX_STORED_AUDIO_BYTES == 1024 * 1024 * 1024
