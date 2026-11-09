"""Request validation for the core API (ARC-07). Pure.

Messages and status codes are the v1 route handlers' (legacy/app/api). Where v1 crashed with an
unhandled 500 (a non-string name, ``folder_id: ""``, …) the intended 400/422 is raised instead.
"""

import re
import uuid
from typing import Any

from app.auth.validate import normalize_username, validate_username
from app.core.errors import BadRequest, Forbidden, UnprocessableEntity
from app.domain.models import Pick, is_model_allowed

CLIENT_EVENT_TYPES = ("record_start", "record_stop", "recording_notice_ack")
TODO_STATUSES = ("open", "done", "dismissed")
SHARE_ROLES = ("editor", "viewer")
THEMES = ("luxury", "default", "playful")
MAX_TITLE = 200
MAX_FOLDER_NAME = 100
MAX_DISPLAY_NAME = 50


def parse_uuid(value: Any) -> uuid.UUID | None:
    if not isinstance(value, str):
        return None
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


def can_reprocess(audio_path: str | None) -> bool:
    """PRV-02: nothing to process once the audio is gone (or was never uploaded)."""
    return bool(audio_path)


# --- names other users see (SEC-05) ----------------------------------------------------------

# Bidi controls, zero-width / invisible format characters and C0/C1 controls: they can reorder the
# text around a name or make one name look like another (CWE-451). Same set as the web's
# `lib/text.ts` displayText, plus control characters.
_INVISIBLE_RE = re.compile(
    "[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]"
)
INVISIBLE_MESSAGE = "Names cannot contain invisible or text-direction characters."


def has_invisible_characters(text: str) -> bool:
    return _INVISIBLE_RE.search(text) is not None


class InvalidNameCharacters(BadRequest):
    code = "invalid_characters"


class InvalidTitleCharacters(UnprocessableEntity):
    code = "invalid_characters"


# --- meetings ---------------------------------------------------------------------------------


def parse_meeting_patch(body: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if "title" in body:
        title = body["title"]
        if not isinstance(title, str):
            raise UnprocessableEntity("title must be a string.")
        title = title.strip()
        if not title:
            raise UnprocessableEntity("title must not be empty.")
        if len(title) > MAX_TITLE:
            raise UnprocessableEntity(f"title must be {MAX_TITLE} characters or fewer.")
        if has_invisible_characters(title):
            raise InvalidTitleCharacters(INVISIBLE_MESSAGE)
        out["title"] = title
    if "folder_id" in body:
        raw = body["folder_id"]
        folder = None if raw is None else parse_uuid(raw)
        if raw is not None and folder is None:
            raise UnprocessableEntity("folder_id must be a UUID string or null.")
        out["folder_id"] = folder
    if not out:
        raise UnprocessableEntity("No updatable fields provided.")
    return out


def parse_todo_status(body: dict[str, Any]) -> str:
    status = body.get("status")
    if status not in TODO_STATUSES:
        raise UnprocessableEntity("status must be one of: open, done, dismissed.")
    return str(status)


def parse_dismissed(body: dict[str, Any]) -> None:
    if body.get("dismissed") is not True:
        raise UnprocessableEntity("dismissed must be true.")


# --- folders and shares -----------------------------------------------------------------------


def parse_folder_name(body: dict[str, Any]) -> str:
    raw = body.get("name")
    name = raw.strip() if isinstance(raw, str) else ""
    if not name:
        raise BadRequest("name is required.")
    if len(name) > MAX_FOLDER_NAME:
        raise BadRequest(f"Folder name too long (max {MAX_FOLDER_NAME} characters).")
    if has_invisible_characters(name):
        raise InvalidNameCharacters(INVISIBLE_MESSAGE)
    return name


def _identifier(body: dict[str, Any]) -> str:
    raw = body.get("identifier")
    identifier = raw.strip() if isinstance(raw, str) else ""
    if not identifier:
        raise UnprocessableEntity("identifier is required.")
    return identifier


def parse_share_role(body: dict[str, Any]) -> str:
    role = body.get("role")
    if role not in SHARE_ROLES:
        raise UnprocessableEntity('role must be "editor" or "viewer".')
    return str(role)


def parse_share_create(body: dict[str, Any]) -> tuple[str, str]:
    return _identifier(body), parse_share_role(body)


def parse_reorder(body: dict[str, Any]) -> list[tuple[uuid.UUID, int]]:
    """(folder id, position). Positions are indexes among the string entries (v1)."""
    order = body.get("order")
    if not isinstance(order, list):
        raise BadRequest("order must be an array of folder IDs.")
    strings = [item for item in order if isinstance(item, str)]
    out = [(parse_uuid(item), pos) for pos, item in enumerate(strings)]
    return [(i, pos) for i, pos in out if i is not None]


def parse_lookup(body: dict[str, Any]) -> str:
    return _identifier(body)


def is_email_identifier(identifier: str) -> bool:
    return "@" in identifier


def normalize_lookup_username(identifier: str) -> str:
    text = identifier.strip()
    return (text[1:] if text.startswith("@") else text).lower().strip()


# --- profile ----------------------------------------------------------------------------------


def parse_profile_patch(body: dict[str, Any], *, allow_empty: bool = False) -> dict[str, Any]:
    """username → display_name → theme_preference, first failure wins (v1 order).

    ``avatar_key`` is parsed by ``app.domain.uploads.parse_avatar_patch``; the route passes
    ``allow_empty`` when the body changes only the avatar.
    """
    out: dict[str, Any] = {}
    if "username" in body:
        raw = body["username"]
        if not isinstance(raw, str):
            raise BadRequest("username must be a string.")
        username = normalize_username(raw)
        error = validate_username(username)
        if error:
            raise UnprocessableEntity(error)
        out["username"] = username
    if "display_name" in body:
        name = body["display_name"]
        if name is not None and not isinstance(name, str):
            raise BadRequest("display_name must be a string or null.")
        if isinstance(name, str) and len(name) > MAX_DISPLAY_NAME:
            raise UnprocessableEntity(
                f"Display name must be at most {MAX_DISPLAY_NAME} characters."
            )
        out["display_name"] = name or None
    if "theme_preference" in body:
        theme = body["theme_preference"]
        if theme is not None and theme not in THEMES:
            raise UnprocessableEntity("theme_preference must be one of: luxury, default, playful.")
        out["theme_preference"] = theme
    if not out and not allow_empty:
        raise BadRequest("No updatable fields provided.")
    return out


def parse_preferences(body: dict[str, Any], allowed: list[Pick]) -> tuple[str | None, str | None]:
    provider, model = body.get("provider", ...), body.get("model", ...)
    if provider is None and model is None:
        return None, None
    if not isinstance(provider, str) or not isinstance(model, str):
        raise BadRequest("provider and model must both be strings, or both null.")
    if not is_model_allowed(provider, model, allowed):
        raise BadRequest(f"{provider}:{model} is not in the current allow-list.")
    return provider, model


# --- activity ---------------------------------------------------------------------------------


def parse_activity(body: dict[str, Any], caller: uuid.UUID) -> tuple[str, uuid.UUID | None]:
    event = body.get("eventType")
    if event not in CLIENT_EVENT_TYPES:
        raise UnprocessableEntity(
            "eventType must be one of: record_start, record_stop, recording_notice_ack."
        )
    if parse_uuid(body.get("userId")) != caller:
        raise Forbidden("Forbidden: userId must match the authenticated user.")
    return str(event), parse_uuid(body.get("meetingId"))
