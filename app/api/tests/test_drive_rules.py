"""ARC-17: pure Drive rules — uploaded-file verification, Range parsing, retry policy, private
root, media stream slots, upload type checks."""

from typing import Any

import pytest

from app.services.storage.base import UnsupportedContentType, base_media_type, check_upload_type
from app.services.storage.drive_rules import (
    MAX_ATTEMPTS,
    ByteRange,
    RangeNotSatisfiable,
    StreamSlots,
    content_range,
    error_reason,
    is_retryable,
    is_valid_file_id,
    parse_range,
    retry_delay,
    root_is_private,
    verify_uploaded_file,
)

ROOT = "root-folder-id-123"
KEY = "11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.webm"


def meta(**over: Any) -> dict[str, Any]:
    m: dict[str, Any] = {
        "id": "file-id-abcdefgh",
        "name": KEY,
        "mimeType": "audio/webm",
        "size": "1000",
        "parents": [ROOT],
        "appProperties": {"key": KEY},
        "md5Checksum": "0" * 32,
        "trashed": False,
    }
    m.update(over)
    return m


def verify(m: dict[str, Any], **over: Any) -> str | None:
    args: dict[str, Any] = {
        "key": KEY,
        "root_id": ROOT,
        "size": 1000,
        "content_type": "audio/webm;codecs=opus",
        "max_bytes": 5000,
    }
    args.update(over)
    return verify_uploaded_file(m, **args)


# --- verify_uploaded_file -------------------------------------------------------------------


def test_matching_file_is_accepted() -> None:
    assert verify(meta()) is None


@pytest.mark.parametrize(
    ("override", "reason"),
    [
        ({"appProperties": {"key": "other/key.webm"}}, "key_mismatch"),
        ({"appProperties": {}}, "key_mismatch"),
        ({"appProperties": None}, "key_mismatch"),
        ({"parents": ["elsewhere"]}, "parent_mismatch"),
        ({"parents": [ROOT, "elsewhere"]}, "parent_mismatch"),
        ({"parents": None}, "parent_mismatch"),
        ({"size": "999"}, "size_mismatch"),
        ({"size": None}, "size_mismatch"),
        ({"size": "abc"}, "size_mismatch"),
        ({"mimeType": "text/html"}, "type_mismatch"),
        ({"mimeType": "audio/mp4"}, "type_mismatch"),
        ({"trashed": True}, "trashed"),
    ],
)
def test_mismatching_file_is_rejected(override: dict[str, Any], reason: str) -> None:
    assert verify(meta(**override)) == reason


def test_file_over_the_cap_is_rejected_even_if_declared() -> None:
    assert verify(meta(size="6000"), size=6000) == "too_large"


def test_mime_type_compare_ignores_parameters_and_case() -> None:
    assert verify(meta(mimeType="Audio/WebM")) is None


# --- upload types -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "ct", ["audio/webm;codecs=opus", "audio/mpeg", "video/mp4", "image/png", "IMAGE/JPEG"]
)
def test_media_upload_types_are_allowed(ct: str) -> None:
    check_upload_type(ct)


@pytest.mark.parametrize("ct", ["text/html", "image/svg+xml", "application/pdf", "", "audio"])
def test_other_upload_types_are_refused(ct: str) -> None:
    with pytest.raises(UnsupportedContentType):
        check_upload_type(ct)


def test_base_media_type() -> None:
    assert base_media_type(" Audio/WebM ; codecs=opus") == "audio/webm"


# --- file ids -----------------------------------------------------------------------------------


@pytest.mark.parametrize("fid", ["1AbC_d-EfGhIjKlMnOp", "x" * 33])
def test_valid_file_ids(fid: str) -> None:
    assert is_valid_file_id(fid)


@pytest.mark.parametrize(
    "fid", ["", "short", "../etc/passwd", "a/b" * 5, "id?alt=media&x=1", "x" * 300]
)
def test_invalid_file_ids(fid: str) -> None:
    assert not is_valid_file_id(fid)


# --- parse_range ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("bytes=1000-1999", ByteRange(1000, 1999)),
        ("bytes=0-0", ByteRange(0, 0)),
        ("bytes=9000-", ByteRange(9000, 9999)),
        ("bytes=9000-20000", ByteRange(9000, 9999)),  # end clamped to size - 1
        ("bytes=-500", ByteRange(9500, 9999)),  # suffix
        ("bytes=-20000", ByteRange(0, 9999)),
        ("Bytes = 5-9", ByteRange(5, 9)),
    ],
)
def test_parse_range(header: str, expected: ByteRange) -> None:
    assert parse_range(header, 10_000) == expected


@pytest.mark.parametrize(
    "header",
    [
        None,
        "",
        "bytes=",
        "bytes=abc-1",
        "items=0-1",
        "bytes=5-1",
        "bytes=0-1,5-9",
        "bytes=-0",
        "bytes=--1",
    ],
)
def test_absent_malformed_or_multi_ranges_mean_full_body(header: str | None) -> None:
    assert parse_range(header, 10_000) is None


@pytest.mark.parametrize("header", ["bytes=10000-", "bytes=20000-30000"])
def test_range_past_the_end_is_not_satisfiable(header: str) -> None:
    with pytest.raises(RangeNotSatisfiable):
        parse_range(header, 10_000)


def test_range_on_empty_file_is_not_satisfiable() -> None:
    with pytest.raises(RangeNotSatisfiable):
        parse_range("bytes=0-", 0)
    assert parse_range("bytes=-5", 0) is None


def test_content_range() -> None:
    assert content_range(ByteRange(1000, 1999), 5000) == "bytes 1000-1999/5000"
    assert ByteRange(1000, 1999).length == 1000
    assert ByteRange(1000, 1999).header == "bytes=1000-1999"


# --- retry --------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "reason", "expected"),
    [
        (429, None, True),
        (500, None, True),
        (502, None, True),
        (503, None, True),
        (504, None, True),
        (403, "rateLimitExceeded", True),
        (403, "userRateLimitExceeded", True),
        (403, "insufficientPermissions", False),
        (403, None, False),
        (400, None, False),
        (401, None, False),
        (404, None, False),
        (200, None, False),
    ],
)
def test_is_retryable(status: int, reason: str | None, expected: bool) -> None:
    assert is_retryable(status, reason) is expected


def test_error_reason_reads_the_drive_error_body() -> None:
    body = {"error": {"code": 403, "errors": [{"reason": "userRateLimitExceeded"}]}}
    assert error_reason(body) == "userRateLimitExceeded"
    assert (
        error_reason({"error": {"status": "x", "details": [{"reason": "rateLimitExceeded"}]}})
        is None
    )
    assert error_reason({"error": "invalid_grant"}) is None
    assert error_reason(None) is None
    assert error_reason("text") is None


def test_retry_delay_grows_exponentially_with_bounded_jitter() -> None:
    assert MAX_ATTEMPTS == 5
    lows = [retry_delay(a, 0.0) for a in range(4)]
    highs = [retry_delay(a, 1.0) for a in range(4)]
    assert lows == sorted(lows) and lows[0] > 0
    assert all(lo < hi for lo, hi in zip(lows, highs, strict=True))
    assert highs[1] == pytest.approx(2 * highs[0])
    assert retry_delay(50, 1.0) <= 32.0


# --- root privacy ---------------------------------------------------------------------------------


def perm(**kw: Any) -> dict[str, Any]:
    p: dict[str, Any] = {"type": "user", "role": "owner", "emailAddress": "Owner@Example.com"}
    p.update(kw)
    return p


def test_root_with_only_the_owner_is_private() -> None:
    assert root_is_private([perm()], "owner@example.com")


@pytest.mark.parametrize(
    "extra",
    [
        perm(role="reader", emailAddress="friend@example.com"),
        perm(type="anyone", role="reader", emailAddress=None),
        perm(type="domain", role="reader", emailAddress=None),
        perm(role="writer"),  # owner email but a second grant is still not "only the owner"
    ],
)
def test_root_with_any_other_permission_is_shared(extra: dict[str, Any]) -> None:
    assert not root_is_private([perm(), extra], "owner@example.com")


def test_owner_permission_for_someone_else_is_shared() -> None:
    assert not root_is_private([perm(emailAddress="thief@example.com")], "owner@example.com")
    assert not root_is_private([], "owner@example.com")


# --- stream slots ---------------------------------------------------------------------------------


def test_stream_slots_cap_concurrency() -> None:
    slots = StreamSlots(2)
    assert slots.try_acquire()
    assert slots.try_acquire()
    assert not slots.try_acquire()
    slots.release()
    assert slots.try_acquire()
    assert slots.in_use == 2


def test_stream_slots_release_never_goes_negative() -> None:
    slots = StreamSlots(1)
    slots.release()
    assert slots.in_use == 0


# --- review round 1 -------------------------------------------------------------------------------


def test_only_this_keys_session_file_counts_as_an_orphan() -> None:
    from app.services.storage.drive_rules import is_session_orphan

    assert is_session_orphan(meta(), key=KEY, root_id=ROOT)
    assert not is_session_orphan(meta(appProperties={"key": "x"}), key=KEY, root_id=ROOT)
    assert not is_session_orphan(meta(appProperties=None), key=KEY, root_id=ROOT)
    assert not is_session_orphan(meta(parents=["x"]), key=KEY, root_id=ROOT)
    folder = meta(mimeType="application/vnd.google-apps.folder")
    assert not is_session_orphan(folder, key=KEY, root_id=ROOT)
    assert not is_session_orphan(meta(id=ROOT), key=KEY, root_id=ROOT)


def test_cap_window() -> None:
    from app.services.storage.drive_rules import cap_window

    assert cap_window(None, 100, 1000) is None  # small file, no range: plain 200
    assert cap_window(None, 5000, 1000) == ByteRange(0, 999)
    assert cap_window(ByteRange(2000, 4999), 5000, 1000) == ByteRange(2000, 2999)
    assert cap_window(ByteRange(10, 20), 5000, 1000) == ByteRange(10, 20)


def test_huge_range_numbers_are_ignored() -> None:
    assert parse_range("bytes=" + "9" * 5000 + "-", 10) is None
    assert parse_range("bytes=٣-٤", 10) is None  # non-ASCII digits


def test_stream_slots_per_key() -> None:
    slots = StreamSlots(8, per_key=2)
    assert slots.try_acquire("a") and slots.try_acquire("a")
    assert not slots.try_acquire("a")
    assert slots.try_acquire("b")
    slots.release("a")
    assert slots.try_acquire("a")
    assert slots.in_use == 3
