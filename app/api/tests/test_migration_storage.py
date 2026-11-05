"""ARC-18 pure rules: which v1 files to copy into Google Drive, and the storage digest."""

import uuid

from app.migration.storage_plan import (
    FileRow,
    Mapped,
    content_type_for,
    etag_md5,
    plan_object_copies,
    same_file,
    storage_digest,
)

U = str(uuid.uuid4())
M = str(uuid.uuid4())
AV = f"avatars/{U}/{uuid.uuid4()}.png"


def _audio(key: str = f"{U}/{M}.webm", provider: str = "supabase") -> FileRow:
    return FileRow("audio", key, U, M, provider)


def _avatar(key: str = AV) -> FileRow:
    return FileRow("avatar", key, U, None, "r2")


def test_unmapped_owned_files_are_copied_whatever_their_v1_source() -> None:
    steps = plan_object_copies([_audio(), _audio(provider="r2"), _avatar()], {})
    assert [s.action for s in steps] == ["copy", "copy", "copy"]


def test_forged_keys_are_rejected_never_copied() -> None:
    rows = [
        _audio(key=f"{uuid.uuid4()}/{M}.webm"),  # another user's prefix
        _audio(key=f"{U}/{M}/../x.webm"),
        FileRow("avatar", f"avatars/{uuid.uuid4()}/{uuid.uuid4()}.png", U, None, "r2"),
        FileRow("avatar", f"avatars/{U}/not-a-uuid.png", U, None, "r2"),
    ]
    assert [s.action for s in plan_object_copies(rows, {})] == ["reject"] * 4


def test_mapped_keys_are_checked_against_the_source_not_copied_again() -> None:
    mapped = {f"{U}/{M}.webm": Mapped(5, "a" * 32)}
    assert [s.action for s in plan_object_copies([_audio()], mapped)] == ["check"]


def test_v2_files_are_left_alone_and_must_be_in_the_map() -> None:
    row = _audio(provider="gdrive")
    assert plan_object_copies([row], {row.key: Mapped(1, None)})[0].action == "skip"
    assert plan_object_copies([row], {})[0].action == "unmapped"


def test_unknown_providers_are_rejected() -> None:
    assert plan_object_copies([_audio(provider="s3")], {})[0].action == "reject"


def test_same_file_compares_size_and_md5_when_known() -> None:
    m = Mapped(5, "a" * 32)
    assert same_file(m, 5, "a" * 32)
    assert same_file(m, 5, None)  # the source has no md5 (multipart upload)
    assert not same_file(m, 6, "a" * 32)
    assert not same_file(m, 5, "b" * 32)
    assert same_file(Mapped(5, None), 5, "b" * 32)
    assert not same_file(m, None, None)  # nothing to compare: never assume
    assert same_file(m, None, "a" * 32)  # Supabase object without a size: md5 decides
    assert not same_file(m, None, "b" * 32)
    assert not same_file(Mapped(5, None), None, "a" * 32)


def test_etag_md5_only_for_a_single_part_upload() -> None:
    assert etag_md5('"0123456789ABCDEF0123456789abcdef"') == "0123456789abcdef0123456789abcdef"
    assert etag_md5("0123456789abcdef0123456789abcdef-3") is None  # multipart
    assert etag_md5(None) is None
    assert etag_md5("") is None


def test_content_type_is_the_base_type_and_fits_the_file_kind() -> None:
    assert content_type_for("a/b.webm", "audio/webm;codecs=opus", "audio") == "audio/webm"
    assert content_type_for("a/b.mp3", None, "audio") == "audio/mpeg"
    assert content_type_for("a/b.m4a", "application/octet-stream", "audio") == "audio/mp4"
    assert content_type_for("a/b.mp4", "", "audio") == "video/mp4"
    assert content_type_for(AV, None, "avatar") == "image/png"
    assert content_type_for("avatars/x/y.jpg", "IMAGE/JPEG", "avatar") == "image/jpeg"
    assert content_type_for("a/b", None, "audio") is None  # no extension, no hint
    assert content_type_for("a/b.exe", "application/x-msdownload", "audio") is None
    # never a prefix match, never a type of the other kind
    assert content_type_for("a/b", "image/pngfoo", "avatar") is None
    assert content_type_for("a/b.webm", "image/png", "audio") == "audio/webm"
    assert content_type_for("a/b.png", "image/png", "audio") is None
    assert content_type_for(AV, "video/mp4", "avatar") == "image/png"


def test_storage_digest_is_order_independent_and_content_sensitive() -> None:
    a = [("k1", 5, "a" * 32), ("k2", 7, None)]
    assert storage_digest(a) == storage_digest(list(reversed(a)))
    assert storage_digest(a) != storage_digest([("k1", 5, "b" * 32), ("k2", 7, None)])
    assert storage_digest(a) != storage_digest([("k1", 6, "a" * 32), ("k2", 7, None)])
    assert storage_digest([]) == storage_digest([])
