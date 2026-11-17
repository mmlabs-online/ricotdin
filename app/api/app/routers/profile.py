"""Profile endpoints: profile, quota balance and model preference (ARC-07); the caller's own
activity feed (PRF-09). Avatars live in Google Drive (part 2): ``POST /profile/avatar`` gives an
upload URL,
``PATCH /profile`` confirms the uploaded file and stores ``avatar_key``; ``avatar_url`` is a
short-lived ``/media`` link."""

import time
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection

from app.auth.deps import client_ip, current_identity
from app.core.errors import (
    BadRequest,
    Conflict,
    NotFound,
)
from app.db.context import RequestIdentity
from app.db.session import Database, get_database
from app.domain.activity import (
    EVENT_TYPES,
    SHARE_EVENTS,
    own_activity_row,
    parse_own_activity_filters,
)
from app.domain.models import allowed_models, model_label
from app.domain.rules import parse_preferences_patch, parse_profile_patch
from app.domain.uploads import (
    MAX_AVATAR_BYTES,
    avatar_content_type,
    avatar_key,
    parse_avatar_patch,
    parse_avatar_request,
)
from app.routers._common import SERVICE, enforce_limit, is_unique_violation, json_object, jsonb
from app.routers.admin._common import Admin, write_audit
from app.routers.meetings import delete_files
from app.services.access import folder_assignable
from app.services.account import delete_account, export_account, zip_response
from app.services.platform import Platform, get_platform
from app.services.storage.media_token import DEFAULT_MEDIA_TTL_S
from app.services.storage.ownership import is_owned_avatar_key

router = APIRouter(prefix="/profile", tags=["profile"])


Identity = Annotated[RequestIdentity, Depends(current_identity)]
Db = Annotated[Database, Depends(get_database)]

_TAKEN = "Username is already taken."


Plat = Annotated[Platform, Depends(get_platform)]


def _avatar_url(platform: Platform, key: str | None, user_id: Any) -> str | None:
    # BUG-002: never sign a link for a key that is not this user's avatar.
    if not key or not is_owned_avatar_key(key, str(user_id)) or platform.media_signer is None:
        return None
    token = platform.media_signer.sign(key, now=time.time(), ttl=DEFAULT_MEDIA_TTL_S)
    return f"/media?t={token}"


@router.get("")
async def get_profile(identity: Identity, db: Db, platform: Plat) -> dict[str, Any]:
    """Own profile, counts of owned meetings / folders and the quota balance (raw, may be
    negative; the UI clamps it)."""
    async with db.role_transaction(SERVICE) as conn:
        row = (
            await conn.execute(
                text(
                    "SELECT p.id, u.email, p.username, p.display_name, p.avatar_key, "
                    "p.theme_preference, p.role, p.created_at, "
                    "(SELECT count(*) FROM public.meetings m WHERE m.user_id = p.id) AS meetings, "
                    "(SELECT count(*) FROM public.folders f WHERE f.user_id = p.id) AS folders, "
                    "w.audio_seconds_remaining, w.agent_queries_remaining "
                    "FROM public.profiles p LEFT JOIN public.users u ON u.id = p.id "
                    "LEFT JOIN public.quota_wallets w ON w.user_id = p.id WHERE p.id = :me"
                ),
                {"me": identity.user_id},
            )
        ).first()
    if row is None:
        raise NotFound("Profile not found.")
    return {
        "id": str(row.id),
        "email": row.email,
        "username": row.username,
        "display_name": row.display_name,
        "avatar_key": row.avatar_key,
        "avatar_url": _avatar_url(platform, row.avatar_key, identity.user_id),
        "theme_preference": row.theme_preference,
        "role": row.role,
        "created_at": row.created_at,
        "meeting_count": int(row.meetings),
        "folder_count": int(row.folders),
        "audio_seconds_remaining": int(row.audio_seconds_remaining or 0),
        "agent_queries_remaining": int(row.agent_queries_remaining or 0),
    }


@router.patch("")
async def update_profile(
    request: Request, identity: Identity, db: Db, platform: Plat
) -> dict[str, bool]:
    """username / display_name / theme_preference / avatar_key. The write runs as ricotdin_app, so
    the ``profiles_update`` policy and the column grant apply (``role`` can never be written).
    A new avatar must be the Drive file uploaded for that key (confirmed first); the old avatar is
    deleted after the new key is saved (v1: only if it really is this user's avatar)."""
    body = await json_object(request)
    changes = parse_profile_patch(body, allow_empty=True)
    avatar = parse_avatar_patch(body, identity.user_id)
    if not changes and avatar is None:
        raise BadRequest("No updatable fields provided.")
    if "username" in changes:
        async with db.role_transaction(SERVICE) as conn:
            taken = await conn.execute(
                text("SELECT 1 FROM public.profiles WHERE username = :u AND id <> :me"),
                {"u": changes["username"], "me": identity.user_id},
            )
            if taken.first() is not None:
                raise Conflict(_TAKEN)
    old_key: str | None = None
    if avatar is not None:
        new_key, file_id, size = avatar
        async with db.role_transaction(SERVICE) as conn:
            old_key = (
                await conn.execute(
                    text("SELECT avatar_key FROM public.profiles WHERE id = :me"),
                    {"me": identity.user_id},
                )
            ).scalar_one_or_none()
            if new_key is not None and new_key != old_key:
                storage = await platform.storage(conn)
                await storage.confirm_upload(
                    new_key,
                    str(file_id),
                    content_type=str(avatar_content_type(new_key)),
                    content_length=int(size or 0),
                    max_bytes=MAX_AVATAR_BYTES,
                )
        changes["avatar_key"] = new_key
    sets = ", ".join(f"{k} = :{k}" for k in changes)
    try:
        async with db.app_transaction(identity) as conn:
            await conn.execute(
                text(f"UPDATE public.profiles SET {sets} WHERE id = :me"),  # noqa: S608 - fixed keys
                {**changes, "me": identity.user_id},
            )
    except IntegrityError as exc:
        if is_unique_violation(exc):
            raise Conflict(_TAKEN) from None
        raise
    if avatar is not None and old_key and old_key != avatar[0]:
        if is_owned_avatar_key(old_key, str(identity.user_id)):
            await delete_files(db, platform, [old_key])  # best effort (v1: non-fatal)
    return {"ok": True}


@router.post("/avatar")
async def avatar_upload(
    request: Request, identity: Identity, db: Db, platform: Plat
) -> dict[str, str]:
    """Step 1 of an avatar change: a one-time Drive upload URL for a new key. Step 2 is
    ``PATCH /profile {avatar_key, avatar_file_id, avatar_size}``."""
    content_type, size = parse_avatar_request(await json_object(request))
    enforce_limit(request.app.state.upload_limiter, identity.user_id)
    key = avatar_key(identity.user_id, content_type)
    async with db.role_transaction(SERVICE) as conn:
        storage = await platform.storage(conn)
        url = await storage.upload_session(key, content_type, size, max_bytes=MAX_AVATAR_BYTES)
    return {"uploadUrl": url, "avatarKey": key}


async def _allowed(db: Database) -> list[tuple[str, str]]:
    async with db.role_transaction(SERVICE) as conn:
        raw = (
            await conn.execute(
                text(
                    "SELECT value FROM public.app_settings WHERE key = 'generation.allowed_models'"
                )
            )
        ).scalar_one_or_none()
    return allowed_models(jsonb(raw))


@router.get("/preferences")
async def get_preferences(identity: Identity, db: Db) -> dict[str, Any]:
    allowed = await _allowed(db)
    async with db.app_transaction(identity) as conn:
        row = (
            await conn.execute(
                text(
                    "SELECT default_provider, default_model, default_folder_id, locale "
                    "FROM public.profiles WHERE id = :me"
                ),
                {"me": identity.user_id},
            )
        ).first()
    folder = row.default_folder_id if row else None
    return {
        "provider": row.default_provider if row else None,
        "model": row.default_model if row else None,
        "defaultFolderId": str(folder) if folder else None,
        "locale": row.locale if row else None,
        "allowedModels": [
            {"provider": p, "model": m, "label": model_label(p, m)} for p, m in allowed
        ],
    }


@router.patch("/preferences")
async def update_preferences(request: Request, identity: Identity, db: Db) -> dict[str, bool]:
    body = await json_object(request)
    changes = parse_preferences_patch(body, await _allowed(db))
    folder = changes.get("default_folder_id")
    if folder is not None:
        async with db.role_transaction(SERVICE) as conn:  # like POST /meetings (shared folders)
            if not await folder_assignable(conn, folder, identity.user_id):
                raise NotFound("Folder not found.")
    async with db.app_transaction(identity) as conn:
        if "default_model" in changes:
            await conn.execute(
                text(
                    "UPDATE public.profiles SET default_provider = :p, default_model = :m "
                    "WHERE id = :me"
                ),
                {
                    "p": changes["default_provider"],
                    "m": changes["default_model"],
                    "me": identity.user_id,
                },
            )
        if "locale" in changes:  # PRF-06: "en" | "vi" | None, checked by parse_preferences_patch
            await conn.execute(
                text("UPDATE public.profiles SET locale = :l WHERE id = :me"),
                {"l": changes["locale"], "me": identity.user_id},
            )
        if "default_folder_id" in changes:
            try:
                async with conn.begin_nested():
                    await conn.execute(
                        text("UPDATE public.profiles SET default_folder_id = :f WHERE id = :me"),
                        {"f": folder, "me": identity.user_id},
                    )
            except IntegrityError as exc:  # folder deleted after the check above (FK)
                raise NotFound("Folder not found.") from exc
    return {"ok": True}


# --- own activity (PRF-09) ------------------------------------------------------------------------

# The caller's rows, plus the folder-share rows that target them. A meeting title only while the
# caller can still see the meeting (owner, folder owner or share), like POST /activity.
_ACTIVITY_WHERE = (
    "a.event_type = ANY(:types) AND (a.user_id = :me OR "
    "(a.target_user_id = :me AND a.event_type = ANY(:share)))"
)


@router.get("/activity")
async def own_activity(request: Request, identity: Identity, db: Db) -> dict[str, Any]:
    """``?eventType&page&perPage`` (20 by default, at most 50), newest first."""
    f = parse_own_activity_filters(request.query_params)
    types = [f.event_type] if f.event_type else list(EVENT_TYPES)
    args = {"me": identity.user_id, "types": types, "share": list(SHARE_EVENTS)}
    async with db.role_transaction(SERVICE) as conn:  # activity_log is admin-only under RLS
        total = (
            await conn.execute(
                text(f"SELECT count(*) FROM public.activity_log a WHERE {_ACTIVITY_WHERE}"),  # noqa: S608
                args,
            )
        ).scalar_one()
        rows = (
            await conn.execute(
                text(
                    "SELECT a.id, a.created_at, a.user_id, a.target_user_id, a.event_type, "  # noqa: S608
                    "a.meeting_id, a.metadata, a.ip, a.user_agent, "
                    "CASE WHEN m.user_id = :me OR f.user_id = :me OR EXISTS (SELECT 1 FROM "
                    "public.folder_shares s WHERE s.folder_id = m.folder_id AND s.user_id = :me) "
                    "THEN m.title END AS meeting_title, "
                    "pa.username AS actor_username, pt.username AS target_username "
                    "FROM public.activity_log a "
                    "LEFT JOIN public.meetings m ON m.id = a.meeting_id "
                    "LEFT JOIN public.folders f ON f.id = m.folder_id "
                    "LEFT JOIN public.profiles pa ON pa.id = a.user_id "
                    "LEFT JOIN public.profiles pt ON pt.id = a.target_user_id "
                    f"WHERE {_ACTIVITY_WHERE} "
                    "ORDER BY a.created_at DESC, a.id DESC LIMIT :lim OFFSET :off"
                ),
                {**args, "lim": f.per_page, "off": (f.page - 1) * f.per_page},
            )
        ).all()
    return {
        "rows": [
            own_activity_row({**r._mapping, "metadata": jsonb(r.metadata)}, identity.user_id)
            for r in rows
        ],
        "total": total,
        "page": f.page,
        "perPage": f.per_page,
    }


# --- own data: export and delete (PRF-13) ---------------------------------------------------------

_TOO_MANY_EXPORTS = "Too many exports. Wait a while and try again."
_CONFIRM = "Type your username to confirm."


async def _actor(db: Database, request: Request, uid: Any) -> Admin:
    """The audit actor for the user's own action (``audit_logs`` keeps the email after a delete)."""
    async with db.role_transaction(SERVICE) as conn:
        email = (
            await conn.execute(text("SELECT email FROM public.users WHERE id = :u"), {"u": uid})
        ).scalar_one_or_none()
    if email is None:
        raise NotFound("Profile not found.")
    return Admin(uid, email, client_ip(request),
                 (request.headers.get("user-agent") or "")[:512] or None)  # fmt: skip


@router.get("/export")
async def export_own_data(request: Request, identity: Identity, db: Db) -> Response:
    """The caller's own meetings, chats, activity and profile as a ZIP (no audio)."""
    enforce_limit(request.app.state.export_limiter, identity.user_id, _TOO_MANY_EXPORTS)
    actor = await _actor(db, request, identity.user_id)
    export = await export_account(db, identity.user_id, datetime.now(UTC))
    if export is None:
        raise NotFound("Profile not found.")
    async with db.role_transaction(SERVICE) as conn:
        await write_audit(conn, actor, "user.export_self", "user", str(identity.user_id),
                          {"meetings": export.meetings, "bytes": len(export.data)})  # fmt: skip
    return zip_response(export)


@router.delete("")
async def delete_own_account(
    request: Request, identity: Identity, db: Db, platform: Plat
) -> dict[str, Any]:
    """``{confirm: "<username>"}``: deletes the caller's ricotdin account like an admin delete
    (Drive files first, then every row). The mmlabs account stays; signing in again creates a new,
    empty ricotdin account."""
    body = await json_object(request, max_bytes=1024)
    uid = identity.user_id
    actor = await _actor(db, request, uid)
    confirm = body.get("confirm")

    confirmed = False

    async def check(conn: AsyncConnection) -> None:
        nonlocal confirmed
        if confirmed:  # second transaction: the username was proven in the first (review A1)
            return
        username = (
            await conn.execute(
                text("SELECT username FROM public.profiles WHERE id = :u"), {"u": uid}
            )
        ).scalar_one_or_none()
        if not isinstance(confirm, str) or username is None or confirm.strip() != username:
            raise BadRequest(_CONFIRM)
        confirmed = True

    async def audit(conn: AsyncConnection, action: str, meta: dict[str, Any]) -> None:
        await write_audit(conn, actor, action, "user", str(uid), meta)

    failed = await delete_account(
        db, platform, uid, check=check, audit=audit, action="user.delete_self",
        on_disabled=lambda: request.app.state.mmlabs_identities.forget_user(uid),
    )  # fmt: skip
    request.app.state.mmlabs_identities.forget_user(uid)
    out: dict[str, Any] = {"ok": True}
    if failed:
        out["storageWarnings"] = [f"Storage cleanup failed for {failed} file(s)."]
    return out
