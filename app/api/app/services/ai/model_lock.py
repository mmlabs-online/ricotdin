"""Per-meeting generation model lock (ARC-08c; v1 AIP-03 ``lib/ai/lock.ts`` + AIP-06
``lib/ai/resolve.ts``). Written once, at the first ``start`` of a meeting: the upload's
``payload.preferred_provider/model`` (only if allowed — it is unchecked at ``/uploaded``), else the
owner's default (``profiles.default_*``), else the system default. Every later run and
``regenerate`` reuse the stored pair."""

import json
import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.domain.models import (
    Pick,
    allowed_models,
    parse_pick,
    resolve_generation_model,
    system_default,
)


def _json(value: Any) -> Any:
    return json.loads(value) if isinstance(value, str) else value


def stored_pick(provider: object, model: object) -> Pick | None:
    if isinstance(provider, str) and isinstance(model, str) and provider and model:
        return provider, model
    return None


async def resolve_for(conn: AsyncConnection, user_id: uuid.UUID, payload: dict[str, Any]) -> Pick:
    rows = (
        await conn.execute(
            text(
                "SELECT key, value FROM app_settings "
                "WHERE key IN ('generation.system_default', 'generation.allowed_models')"
            )
        )
    ).all()
    settings = {r.key: _json(r.value) for r in rows}
    pref_row = (
        await conn.execute(
            text("SELECT default_provider, default_model FROM profiles WHERE id = :u"),
            {"u": user_id},
        )
    ).first()
    pref = stored_pick(pref_row[0], pref_row[1]) if pref_row else None
    pick = parse_pick(
        {"provider": payload.get("preferred_provider"), "model": payload.get("preferred_model")}
    )
    return resolve_generation_model(
        allowed_models(settings.get("generation.allowed_models")),
        system_default(settings.get("generation.system_default")),
        pref,
        pick,
    )


async def lock_model(
    conn: AsyncConnection, meeting: dict[str, Any], payload: dict[str, Any]
) -> Pick:
    """The meeting's locked pair; resolves and stores one when the meeting has none."""
    held = stored_pick(meeting.get("generation_provider"), meeting.get("generation_model"))
    if held is not None:
        return held
    pick = await resolve_for(conn, meeting["user_id"], payload)
    row = (
        await conn.execute(
            text(
                "UPDATE meetings SET generation_provider = :p, generation_model = :m "
                "WHERE id = :id AND generation_provider IS NULL "
                "RETURNING generation_provider, generation_model"
            ),
            {"p": pick[0], "m": pick[1], "id": meeting["id"]},
        )
    ).first()
    if row is None:  # locked concurrently: use what is stored
        again = (
            await conn.execute(
                text("SELECT generation_provider, generation_model FROM meetings WHERE id = :id"),
                {"id": meeting["id"]},
            )
        ).first()
        held = stored_pick(again[0], again[1]) if again else None
        return held or pick
    return pick
