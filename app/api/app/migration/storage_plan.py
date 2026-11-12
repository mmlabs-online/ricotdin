"""v1 files → Google Drive (ARC-18). Pure: which files to copy, and how to compare them.

Every meeting audio key and avatar key read from the migrated rows is checked for ownership
first (keys are user-influenced, §9m); a v1 file (``r2`` or legacy ``supabase``) is copied once
and then only compared with its source; a v2 file (``gdrive``) is never touched.
"""

import hashlib
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

from app.services.storage.ownership import is_owned_audio_key, is_owned_avatar_key

Kind = Literal["audio", "avatar"]
Action = Literal["copy", "check", "skip", "reject", "unmapped"]
V1_PROVIDERS = ("r2", "supabase")
MAX_BYTES: dict[Kind, int] = {"audio": 1024 * 1024 * 1024, "avatar": 5 * 1024 * 1024}

_MD5 = re.compile(r"[0-9a-f]{32}")
_KIND_TYPES: dict[Kind, re.Pattern[str]] = {
    "audio": re.compile(r"(audio|video)/[a-z0-9.+-]{1,64}"),
    "avatar": re.compile(r"image/(jpeg|png|webp)"),
}
_BY_EXTENSION = {
    "webm": "audio/webm", "ogg": "audio/ogg", "oga": "audio/ogg", "opus": "audio/ogg",
    "mp3": "audio/mpeg", "m4a": "audio/mp4", "aac": "audio/aac", "wav": "audio/wav",
    "flac": "audio/flac", "mp4": "video/mp4", "mov": "video/quicktime", "mkv": "video/x-matroska",
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp",
}  # fmt: skip


@dataclass(frozen=True)
class FileRow:
    """A file named by a migrated row (``meetings.audio_path`` / ``profiles.avatar_key``)."""

    kind: Kind
    key: str
    owner_id: str
    meeting_id: str | None
    provider: str  # where v1 kept it: r2 | supabase; gdrive = a v2 upload


@dataclass(frozen=True)
class Mapped:
    """A ``storage_objects`` row of the target."""

    size: int
    md5: str | None


@dataclass(frozen=True)
class Step:
    row: FileRow
    action: Action


def _owned(row: FileRow) -> bool:
    if row.kind == "audio":
        return row.meeting_id is not None and is_owned_audio_key(
            row.key, row.owner_id, row.meeting_id
        )
    return is_owned_avatar_key(row.key, row.owner_id)


def plan_object_copies(rows: Iterable[FileRow], mapped: Mapping[str, Mapped]) -> list[Step]:
    """copy: a v1 file not in Drive yet · check: already mapped, compare with the source ·
    skip: a v2 file in the map · unmapped: a v2 file missing from the map · reject: a key that
    is not its row's own, or an unknown provider (never copied)."""
    steps: list[Step] = []
    for row in rows:
        if not _owned(row):
            action: Action = "reject"
        elif row.provider == "gdrive":
            action = "skip" if row.key in mapped else "unmapped"
        elif row.provider not in V1_PROVIDERS:
            action = "reject"
        else:
            action = "check" if row.key in mapped else "copy"
        steps.append(Step(row, action))
    return steps


def same_file(mapped: Mapped, size: int | None, md5: str | None) -> bool:
    """Whether the mapped Drive file is the source file: sizes equal when the source has one,
    md5s equal when both sides have one, and at least one of the two actually compared."""
    if size is not None and size != mapped.size:
        return False
    if md5 is not None and mapped.md5 is not None:
        return md5 == mapped.md5
    return size is not None


def etag_md5(etag: str | None) -> str | None:
    """An S3 / Supabase ETag is the md5 only for a single-part upload (no ``-<parts>`` suffix)."""
    value = (etag or "").strip().strip('"').lower()
    return value if _MD5.fullmatch(value) else None


def content_type_for(key: str, hint: str | None, kind: Kind) -> str | None:
    """The source's base media type when it fits the file kind (audio/video for meetings, the
    avatar image types), else the one of the extension; None = not copied."""
    allowed = _KIND_TYPES[kind]
    base = (hint or "").split(";", 1)[0].strip().lower()
    if allowed.fullmatch(base):
        return base
    name = key.rsplit("/", 1)[-1]
    if "." not in name:
        return None
    by_ext = _BY_EXTENSION.get(name.rsplit(".", 1)[-1].lower())
    return by_ext if by_ext and allowed.fullmatch(by_ext) else None


def storage_digest(entries: Sequence[tuple[str, int, str | None]]) -> str:
    """Order-independent digest of (key, size, md5) — the report compares runs with it."""
    lines = sorted(f"{k}\t{s}\t{m or '-'}" for k, s, m in entries)
    return hashlib.sha256("\n".join(lines).encode()).hexdigest()
