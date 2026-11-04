"""Upload rules for meetings and avatars (ARC-07 part 2). Pure.

Ports of the v1 handlers (``legacy/app/api/meetings/route.ts``, ``meetings/[id]/uploaded``,
``profile/avatar``, ``profile``) adapted to Google Drive (ARC-17): a resumable upload session
needs the size up front, and the browser reports the Drive file id afterwards.
"""

import re
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from app.core.errors import BadRequest, NotFound, UnprocessableEntity
from app.domain.rules import parse_uuid
from app.services.storage.base import base_media_type
from app.services.storage.drive_rules import is_valid_file_id
from app.services.storage.ownership import is_owned_avatar_key

# New uploads (owner decision 2026-11-04, ARC-12; v1 allowed 1 GB). Files already stored — v1
# meetings copied by ARC-18 — can be up to 1 GB, so the worker reads with MAX_STORED_AUDIO_BYTES.
MAX_UPLOAD_BYTES = 500 * 1024 * 1024
MAX_STORED_AUDIO_BYTES = 1024 * 1024 * 1024
MAX_AVATAR_BYTES = 2 * 1024 * 1024
AUDIO_EXTENSIONS = (".mp3", ".m4a", ".wav", ".aac", ".ogg", ".flac", ".webm")
VIDEO_EXTENSIONS = (".mp4", ".mov", ".avi", ".mkv", ".m4v")
MIME_BY_EXT = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".webm": "audio/webm",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".m4v": "video/mp4",
}
AVATAR_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
SOURCES = ("uploaded", "video")
TITLE_TZ = ZoneInfo("Asia/Ho_Chi_Minh")  # owner decision 2026-11-02 (v1 used the server zone)
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
# type/subtype plus simple parameters (``;codecs=opus``); anything else is replaced by the
# extension's type (it is sent to Drive as a header and echoed back).
_SAFE_MIME = re.compile(r"[a-z0-9.+-]+/[a-z0-9.+-]+(?:; ?[a-z0-9-]+=[A-Za-z0-9.,+-]+)*", re.I)
_TOO_LARGE = f"File exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MB upload limit."


@dataclass(frozen=True)
class MeetingCreate:
    ext: str
    source: str
    content_type: str
    size: int
    duration_seconds: int | None
    started_at: datetime | None
    folder_id: uuid.UUID | None


@dataclass(frozen=True)
class Uploaded:
    file_id: str
    size: int
    preferred: tuple[str, str] | None


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _size(value: Any, maximum: int, too_large: str) -> int:
    if not _is_int(value) or value <= 0:
        raise UnprocessableEntity("size must be a positive number.")
    if value > maximum:
        raise UnprocessableEntity(too_large)
    return int(value)


def _extension(raw: Any) -> str:
    if raw is None or raw == "":
        return ".webm"
    text = raw.lower() if isinstance(raw, str) else str(raw)
    ext = text if text.startswith(".") else f".{text}"
    if ext not in MIME_BY_EXT:
        raise BadRequest(
            f'Unsupported file extension "{ext}". '
            f"Allowed audio: {', '.join(AUDIO_EXTENSIONS)}. "
            f"Allowed video: {', '.join(VIDEO_EXTENSIONS)}."
        )
    return ext


def parse_meeting_create(body: dict[str, Any]) -> MeetingCreate:
    """v1 order: extension (400), then the rest (422); an unknown folder id is 404 like v1."""
    ext = _extension(body.get("fileExtension"))
    source = body["source"] if body.get("source") in SOURCES else "recorded"
    expected = MIME_BY_EXT[ext]
    mime = body.get("mimeType")
    # The browser's full type (``audio/webm;codecs=opus``) is kept when it agrees with the
    # extension; otherwise the extension decides (Drive and the confirm check use it).
    content_type = expected
    if (
        isinstance(mime, str)
        and len(mime) <= 100
        and _SAFE_MIME.fullmatch(mime) is not None
        and base_media_type(mime) == expected
    ):
        content_type = mime
    size = _size(body.get("size"), MAX_UPLOAD_BYTES, _TOO_LARGE)
    duration = body.get("durationSeconds")
    if duration is not None and (not _is_int(duration) or duration < 0):
        raise UnprocessableEntity("durationSeconds must be a non-negative whole number.")
    started = body.get("startedAt")
    started_at = None
    if started is not None:
        try:
            started_at = datetime.fromisoformat(started) if isinstance(started, str) else None
        except ValueError:
            started_at = None
        if started_at is None or started_at.tzinfo is None:
            raise UnprocessableEntity("startedAt must be an ISO 8601 date-time with a time zone.")
    folder_raw = body.get("folderId")
    folder = None
    if folder_raw not in (None, ""):  # v1: "" means no folder
        folder = parse_uuid(folder_raw)
        if folder is None:
            raise NotFound("Folder not found.")
    return MeetingCreate(ext, source, content_type, size, duration, started_at, folder)


def upload_content_type(key: str) -> str | None:
    """The media type a stored meeting key was created with (from its extension)."""
    name = key.rsplit("/", 1)[-1]
    if "." not in name:
        return None
    return MIME_BY_EXT.get("." + name.rsplit(".", 1)[-1].lower())


def audio_key(user_id: uuid.UUID, meeting_id: uuid.UUID, ext: str) -> str:
    return f"{user_id}/{meeting_id}{ext}"


def avatar_key(user_id: uuid.UUID, content_type: str) -> str:
    return (
        f"avatars/{user_id}/{uuid.UUID(bytes=secrets.token_bytes(16), version=4)}"
        + (AVATAR_TYPES[content_type])
    )


def format_meeting_title(when: datetime) -> str:
    """``Nov 2, 2026, 3:05 PM`` (v1's en-US format) in Vietnam time."""
    local = when.astimezone(TITLE_TZ)
    hour = local.hour % 12 or 12
    half = "AM" if local.hour < 12 else "PM"
    return f"{_MONTHS[local.month - 1]} {local.day}, {local.year}, {hour}:{local.minute:02d} {half}"


def parse_uploaded(body: dict[str, Any]) -> Uploaded:
    file_id = body.get("fileId")
    if not isinstance(file_id, str) or not is_valid_file_id(file_id):
        raise UnprocessableEntity("fileId is required.")
    size = _size(body.get("size"), MAX_UPLOAD_BYTES, _TOO_LARGE)
    provider, model = body.get("preferred_provider"), body.get("preferred_model")
    preferred = (provider, model) if isinstance(provider, str) and isinstance(model, str) else None
    return Uploaded(file_id, size, preferred)


def parse_avatar_request(body: dict[str, Any]) -> tuple[str, int]:
    content_type = body.get("contentType")
    if not isinstance(content_type, str) or content_type not in AVATAR_TYPES:
        raise UnprocessableEntity(f"contentType must be one of: {', '.join(AVATAR_TYPES)}.")
    size = _size(
        body.get("size"),
        MAX_AVATAR_BYTES,
        f"Avatar must be smaller than {MAX_AVATAR_BYTES // (1024 * 1024)} MB.",
    )
    return content_type, size


def avatar_content_type(key: str) -> str | None:
    ext = "." + key.rsplit(".", 1)[-1].lower() if "." in key else ""
    return next((ct for ct, e in AVATAR_TYPES.items() if e == ext), None)


def parse_avatar_patch(
    body: dict[str, Any], user_id: uuid.UUID
) -> tuple[str | None, str | None, int | None] | None:
    """``None`` when the body does not change the avatar; else (key, file_id, size), all None to
    clear it. A new key must be this user's avatar key (BUG-002) and come with its Drive file."""
    if "avatar_key" not in body:
        return None
    key = body["avatar_key"]
    if key is None:
        return None, None, None
    if not isinstance(key, str):
        raise BadRequest("avatar_key must be a string or null.")
    if not is_owned_avatar_key(key, str(user_id)):
        raise UnprocessableEntity("Invalid avatar_key.")
    file_id = body.get("avatar_file_id")
    if not isinstance(file_id, str) or not is_valid_file_id(file_id):
        raise UnprocessableEntity("avatar_file_id is required with a new avatar_key.")
    size = _size(
        body.get("avatar_size"),
        MAX_AVATAR_BYTES,
        f"Avatar must be smaller than {MAX_AVATAR_BYTES // (1024 * 1024)} MB.",
    )
    return key, file_id, size
