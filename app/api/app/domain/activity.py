"""The caller's own activity feed (PRF-09). Pure: query parsing and row shaping.

A user sees the rows they wrote (with their own IP and user agent) and the folder-share rows that
target them (with the actor's username, never the actor's IP or user agent)."""

import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from app.core.errors import BadRequest
from app.domain.admin import MAX_PAGE

SHARE_EVENTS = ("folder_shared", "folder_unshared")
EVENT_TYPES = (
    "meeting_created",
    "meeting_deleted",
    "processing_done",
    "processing_failed",
    "record_start",
    "record_stop",
    "recording_notice_ack",
    "chat_message",
    *SHARE_EVENTS,
)
DEFAULT_PER_PAGE = 20
MAX_PER_PAGE = 50
MAX_NAME_CHARS = 200
_DIGITS = re.compile(r"[0-9]{1,6}")  # ASCII only: str.isdigit() also takes '²'


@dataclass(frozen=True)
class OwnActivityFilters:
    page: int
    per_page: int
    event_type: str | None


def _bounded_int(raw: Any, name: str, default: int, high: int) -> int:
    if raw is None or raw == "":
        return default
    text = str(raw).strip()
    if not _DIGITS.fullmatch(text) or not 1 <= int(text) <= high:
        raise BadRequest(f"{name} must be a whole number from 1 to {high}.")
    return int(text)


def parse_own_activity_filters(query: Mapping[str, Any]) -> OwnActivityFilters:
    event = str(query.get("eventType") or "").strip() or None
    if event is not None and event not in EVENT_TYPES:
        raise BadRequest("Unknown event type.")
    return OwnActivityFilters(
        page=_bounded_int(query.get("page"), "page", 1, MAX_PAGE),
        per_page=_bounded_int(query.get("perPage"), "perPage", DEFAULT_PER_PAGE, MAX_PER_PAGE),
        event_type=event,
    )


def share_metadata(
    folder_id: uuid.UUID, folder_name: str, *, role: str | None = None, left: bool = False
) -> dict[str, Any]:
    """``activity_log.metadata`` of a ``folder_shared`` / ``folder_unshared`` row."""
    out: dict[str, Any] = {"folder_id": str(folder_id), "folder_name": folder_name}
    if role is not None:
        out["role"] = role
    if left:
        out["left"] = True
    return out


def deleted_meeting_metadata(meeting_id: uuid.UUID, title: str | None) -> dict[str, Any]:
    """``metadata`` of a ``meeting_deleted`` row: the row is gone, so its id and (short) title."""
    return {"meeting_id": str(meeting_id), "title": (title or "")[:MAX_NAME_CHARS] or None}


def _name(meta: Mapping[str, Any], key: str) -> str | None:
    value = meta.get(key)
    return value[:MAX_NAME_CHARS] if isinstance(value, str) and value else None


def own_activity_row(row: Mapping[str, Any], me: uuid.UUID) -> dict[str, Any]:
    """One feed entry. ``row`` carries the ``activity_log`` columns plus ``meeting_title`` (NULL
    unless the caller can still see the meeting), ``actor_username`` and ``target_username``."""
    meta: Mapping[str, Any] = row["metadata"] if isinstance(row["metadata"], Mapping) else {}
    mine = row["user_id"] == me
    title = row["meeting_title"]
    if title is None and row["event_type"] == "meeting_deleted":
        title = _name(meta, "title")
    return {
        "id": str(row["id"]),
        "createdAt": row["created_at"],
        "eventType": row["event_type"],
        "direction": "out" if mine else "in",
        "meetingId": str(row["meeting_id"]) if row["meeting_id"] and row["meeting_title"] else None,
        "meetingTitle": title,
        "folderName": _name(meta, "folder_name"),
        "role": _name(meta, "role"),
        "otherUser": row["target_username"] if mine else row["actor_username"],
        "left": meta.get("left") is True,
        "ip": row["ip"] if mine else None,
        "userAgent": row["user_agent"] if mine else None,
    }
