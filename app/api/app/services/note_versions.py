"""Version rows of a meeting's summary / notes (PRO-06). Run as ricotdin_service inside the
transaction that changes the field, after the meeting row is locked."""

import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.domain.content import (
    ContentField,
    VersionSource,
    version_author,
    versions_to_prune,
    versions_to_write,
)


async def record_versions(
    conn: AsyncConnection,
    meeting_id: uuid.UUID,
    field: ContentField,
    *,
    current: str | None,
    new: str,
    source: VersionSource,
    editor: uuid.UUID | None,
) -> None:
    newest: str | None = (
        await conn.execute(
            text(
                "SELECT content FROM public.meeting_note_versions WHERE meeting_id = :m "
                "AND field = :f ORDER BY seq DESC LIMIT 1"
            ),
            {"m": meeting_id, "f": field},
        )
    ).scalar_one_or_none()
    for content, src in versions_to_write(newest=newest, current=current, new=new, source=source):
        await conn.execute(
            text(
                "INSERT INTO public.meeting_note_versions "
                "(meeting_id, field, content, source, edited_by) VALUES (:m, :f, :c, :s, :e)"
            ),
            {"m": meeting_id, "f": field, "c": content, "s": src, "e": version_author(src, editor)},
        )
    ids = [
        r.id
        for r in await conn.execute(
            text(
                "SELECT id FROM public.meeting_note_versions WHERE meeting_id = :m AND field = :f "
                "ORDER BY seq DESC"
            ),
            {"m": meeting_id, "f": field},
        )
    ]
    stale = versions_to_prune(ids)
    if stale:
        await conn.execute(
            text("DELETE FROM public.meeting_note_versions WHERE id = ANY(:ids)"), {"ids": stale}
        )
