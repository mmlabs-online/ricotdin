"""Access facts for API-enforced writes (ARC-07).

Meeting content is SELECT-only for ``ricotdin_app`` (CLAUDE.md §0.1), so editor-level writes run as
``ricotdin_service``. The role is decided in the same transaction as the write, from the facts
below, by the pure rules in ``app.domain.access`` (same logic as SQL ``can_access_meeting``).
"""

import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.domain.access import Role, can_assign_to_folder, can_view_folder, meeting_role


@dataclass(frozen=True)
class MeetingFacts:
    id: uuid.UUID
    user_id: uuid.UUID
    folder_id: uuid.UUID | None
    audio_path: str | None
    pinned_at: Any
    role: Role | None

    def is_meeting_owner(self, user_id: uuid.UUID) -> bool:
        return self.user_id == user_id


_FACTS = """
SELECT m.id, m.user_id, m.folder_id, m.audio_path, m.pinned_at,
       f.user_id AS folder_owner, fs.role AS share_role
FROM public.meetings m
LEFT JOIN public.folders f ON f.id = m.folder_id
LEFT JOIN public.folder_shares fs ON fs.folder_id = m.folder_id AND fs.user_id = :uid
WHERE m.id = :mid
"""


async def meeting_facts(
    conn: AsyncConnection, meeting_id: uuid.UUID, user_id: uuid.UUID, *, lock: bool = False
) -> MeetingFacts | None:
    sql = _FACTS + (" FOR UPDATE OF m" if lock else "")
    row = (await conn.execute(text(sql), {"mid": meeting_id, "uid": user_id})).first()
    if row is None:
        return None
    return MeetingFacts(
        id=row.id,
        user_id=row.user_id,
        folder_id=row.folder_id,
        audio_path=row.audio_path,
        pinned_at=row.pinned_at,
        role=meeting_role(
            user_id,
            meeting_owner=row.user_id,
            folder_owner=row.folder_owner,
            share_role=row.share_role,
        ),
    )


async def _folder_facts(
    conn: AsyncConnection, folder_id: uuid.UUID, user_id: uuid.UUID
) -> tuple[uuid.UUID | None, str | None]:
    row = (
        await conn.execute(
            text(
                "SELECT f.user_id, fs.role FROM public.folders f "
                "LEFT JOIN public.folder_shares fs ON fs.folder_id = f.id AND fs.user_id = :uid "
                "WHERE f.id = :fid"
            ),
            {"fid": folder_id, "uid": user_id},
        )
    ).first()
    return (None, None) if row is None else (row[0], row[1])


async def folder_assignable(
    conn: AsyncConnection, folder_id: uuid.UUID, user_id: uuid.UUID
) -> bool:
    owner, share = await _folder_facts(conn, folder_id, user_id)
    return can_assign_to_folder(user_id, folder_owner=owner, share_role=share)


async def folder_viewable(conn: AsyncConnection, folder_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    owner, share = await _folder_facts(conn, folder_id, user_id)
    return can_view_folder(user_id, folder_owner=owner, share_role=share)
