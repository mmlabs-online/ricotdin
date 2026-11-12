"""Storage-key ownership (ARC-06; ports of v1 ``retention/policy.ts`` and
``profile/avatarKey.ts``, BUG-002/003/004). Pure.

Keys read from database rows are user-influenced, so every server-side sign, download or delete
must first prove the key belongs to that row:
- audio: ``<user_id>/<meeting_id>[.ext]`` (ext 1–10 alphanumerics);
- avatar: ``avatars/<user_id>/<lowercase uuid>.(jpg|png|webp)``.
"""

import re
from collections.abc import Iterable, Mapping
from typing import Any

_AUDIO_SUFFIX = re.compile(r"(?:\.[A-Za-z0-9]{1,10})?")
_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_AVATAR = re.compile(rf"avatars/([^/]+)/{_UUID}\.(?:jpg|png|webp)")


def is_owned_audio_key(key: str, user_id: str, meeting_id: str) -> bool:
    if not key or not user_id or not meeting_id:
        return False
    prefix = f"{user_id}/{meeting_id}"
    return key.startswith(prefix) and _AUDIO_SUFFIX.fullmatch(key[len(prefix) :]) is not None


def owned_audio_path(meeting: Mapping[str, Any]) -> str | None:
    """The meeting's own audio key, or None (missing, or forged to point elsewhere)."""
    key = meeting.get("audio_path")
    if not key:
        return None
    ok = is_owned_audio_key(str(key), str(meeting["user_id"]), str(meeting["id"]))
    return str(key) if ok else None


def owned_audio_delete_items(meetings: Iterable[Mapping[str, Any]]) -> list[tuple[str, str]]:
    """(key, storage_provider) for each meeting's own object only."""
    items: list[tuple[str, str]] = []
    for m in meetings:
        key = owned_audio_path(m)
        if key:
            items.append((key, str(m["storage_provider"])))
    return items


def is_owned_avatar_key(key: str, user_id: str) -> bool:
    if not key or not user_id:
        return False
    m = _AVATAR.fullmatch(key)
    return m is not None and m.group(1) == user_id
