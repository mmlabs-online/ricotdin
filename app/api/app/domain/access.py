"""Meeting and folder roles (ARC-07). Pure; mirrors SQL ``can_access_meeting`` and legacy
``lib/access``: the meeting owner and the owner of the meeting's folder are ``owner``; a folder
share gives ``editor`` or ``viewer``; anyone else has no role. Admins get no extra access.
"""

import uuid
from typing import Literal

Role = Literal["owner", "editor", "viewer"]
_RANK: dict[str, int] = {"viewer": 1, "editor": 2, "owner": 3}


def meeting_role(
    user_id: uuid.UUID,
    *,
    meeting_owner: uuid.UUID,
    folder_owner: uuid.UUID | None,
    share_role: str | None,
) -> Role | None:
    if user_id == meeting_owner or (folder_owner is not None and user_id == folder_owner):
        return "owner"
    if share_role == "editor":
        return "editor"
    if share_role == "viewer":
        return "viewer"
    return None


def has_role(role: Role | None, minimum: Role) -> bool:
    if minimum not in _RANK:
        raise ValueError(f"unknown role {minimum!r}")
    return role is not None and _RANK[role] >= _RANK[minimum]


def can_assign_to_folder(
    user_id: uuid.UUID, *, folder_owner: uuid.UUID | None, share_role: str | None
) -> bool:
    """Owner or editor of the destination folder (``folder_owner`` None = folder missing)."""
    if folder_owner is None:
        return False
    return user_id == folder_owner or share_role == "editor"
