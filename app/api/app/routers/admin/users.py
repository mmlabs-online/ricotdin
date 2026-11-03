"""Admin user management (ARC-10a; port of v1 ``app/api/admin/users/**``, CLAUDE.md §9c).

All SQL runs as ``ricotdin_service``. Role source of truth is ``users.role`` (a trigger mirrors
``profiles.role``); disabled = ``users.disabled_at`` (v1 ``banned_until``). Self / last-admin
guards keep v1's messages (400); the admin rows are locked while counting. Every mutation writes
one ``audit_logs`` row in the same transaction. Disabling revokes every refresh token, so the
user is signed out within the access-token lifetime (≤ 15 min).
"""

import json
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.auth import service as auth_service
from app.auth.deps import auth_runtime
from app.auth.runtime import RESET_TTL, AuthRuntime
from app.core.errors import NotFound
from app.core.logging import get_logger
from app.db.session import Database, get_database
from app.domain.admin import (
    exclude_self,
    guard_delete,
    guard_disable,
    guard_promotion,
    guard_role_change,
    like_pattern,
    month_range,
    parse_bulk,
    parse_list_params,
    parse_quota_grant,
    parse_role,
    parse_status,
    user_status,
)
from app.email.templates import reset_password_email
from app.routers._common import SERVICE, json_object, jsonb, path_id
from app.routers.admin._common import CurrentAdmin, lock_admin_count, write_audit
from app.routers.auth import enforce, link, send_mail
from app.routers.meetings import delete_files
from app.services.platform import Platform, get_platform
from app.services.storage.ownership import is_owned_audio_key, is_owned_avatar_key

router = APIRouter(prefix="/admin", tags=["admin"])
log = get_logger("admin.users")

Db = Annotated[Database, Depends(get_database)]
Plat = Annotated[Platform, Depends(get_platform)]
Runtime = Annotated[AuthRuntime, Depends(auth_runtime)]

_NOT_FOUND = "User not found."
_USER_COLUMNS = (
    "u.id, u.email, p.username, u.role, u.disabled_at, u.email_verified_at, u.created_at, "
    "u.last_sign_in_at"
)


def _status(row: Any) -> Any:
    return user_status(disabled_at=row.disabled_at, email_verified_at=row.email_verified_at)


def _user_out(row: Any) -> dict[str, Any]:
    return {
        "id": row.id,
        "email": row.email,
        "username": row.username,
        "role": row.role,
        "disabled": row.disabled_at is not None,
        "email_confirmed": row.email_verified_at is not None,
        "status": user_status(disabled_at=row.disabled_at, email_verified_at=row.email_verified_at),
        "created_at": row.created_at,
        "last_sign_in_at": row.last_sign_in_at,
    }


async def _target(conn: AsyncConnection, user_id: uuid.UUID) -> Any:
    row = (
        await conn.execute(
            text(
                "SELECT id, email, role, disabled_at, email_verified_at FROM public.users "
                "WHERE id = :id FOR NO KEY UPDATE"
            ),
            {"id": user_id},
        )
    ).first()
    if row is None:
        raise NotFound(_NOT_FOUND)
    return row


# --- list + detail -------------------------------------------------------------------------------


@router.get("/users")
async def list_users(request: Request, admin: CurrentAdmin, db: Db) -> dict[str, Any]:
    """``?page&perPage&search&month``: users with meeting count and the month's AI usage
    (tokens and audio seconds kept apart, CLAUDE.md §9e). Search matches email or username."""
    params = parse_list_params(request.query_params)
    label, start, end = month_range(request.query_params.get("month"), datetime.now(UTC))
    where = (
        "WHERE (:q = '' OR lower(u.email) LIKE :pat ESCAPE '\\' "
        "OR lower(p.username) LIKE :pat ESCAPE '\\')"
    )
    args = {"q": params.search, "pat": like_pattern(params.search)}
    async with db.role_transaction(SERVICE) as conn:
        total = (
            await conn.execute(
                text(
                    "SELECT count(*) FROM public.users u "  # noqa: S608 - constant fragments
                    f"LEFT JOIN public.profiles p ON p.id = u.id {where}"
                ),
                args,
            )
        ).scalar_one()
        rows = (
            await conn.execute(
                text(
                    "WITH page AS (SELECT "  # noqa: S608 - constant fragments
                    f"{_USER_COLUMNS} FROM public.users u "
                    f"LEFT JOIN public.profiles p ON p.id = u.id {where} "
                    "ORDER BY u.created_at DESC, u.id LIMIT :lim OFFSET :off) "
                    "SELECT page.*, "
                    "(SELECT count(*) FROM public.meetings m WHERE m.user_id = page.id) "
                    "AS meetings, "
                    "(SELECT COALESCE(sum(l.total_tokens), 0) FROM public.usage_log l "
                    " WHERE l.user_id = page.id AND l.unit = 'tokens' "
                    " AND l.created_at >= :s AND l.created_at < :e) AS tokens, "
                    "(SELECT COALESCE(sum(l.audio_seconds), 0) FROM public.usage_log l "
                    " WHERE l.user_id = page.id AND l.unit = 'audio_seconds' "
                    " AND l.created_at >= :s AND l.created_at < :e) AS seconds "
                    "FROM page ORDER BY page.created_at DESC, page.id"
                ),
                {**args, "lim": params.per_page, "off": (params.page - 1) * params.per_page,
                 "s": start, "e": end},
            )
        ).all()  # fmt: skip
    users = [
        {**_user_out(r), "meeting_count": r.meetings, "gemini_tokens": int(r.tokens),
         "audio_seconds": float(r.seconds)}
        for r in rows
    ]  # fmt: skip
    return {
        "users": users,
        "total": total,
        "page": params.page,
        "perPage": params.per_page,
        "month": label,
    }


@router.get("/users/{user_id}")
async def get_user(user_id: str, admin: CurrentAdmin, db: Db) -> dict[str, Any]:
    uid = path_id(user_id, _NOT_FOUND)
    async with db.role_transaction(SERVICE) as conn:
        row = (
            await conn.execute(
                text(
                    f"SELECT {_USER_COLUMNS}, "  # noqa: S608 - constant fragment
                    "(SELECT count(*) FROM public.meetings m WHERE m.user_id = u.id) AS meetings "
                    "FROM public.users u LEFT JOIN public.profiles p ON p.id = u.id "
                    "WHERE u.id = :id"
                ),
                {"id": uid},
            )
        ).first()
    if row is None:
        raise NotFound(_NOT_FOUND)
    return {**_user_out(row), "meeting_count": row.meetings}


# --- role / status / reset ------------------------------------------------------------------------


@router.patch("/users/{user_id}/role")
async def change_role(user_id: str, request: Request, admin: CurrentAdmin, db: Db) -> Any:
    uid = path_id(user_id, _NOT_FOUND)
    new_role = parse_role(await json_object(request))
    async with db.role_transaction(SERVICE) as conn:
        count = await lock_admin_count(conn, admin, uid)
        target = await _target(conn, uid)
        guard_role_change(admin.user_id, uid, target.role, new_role, count)
        guard_promotion(new_role, _status(target))
        await conn.execute(
            text("UPDATE public.users SET role = :r, updated_at = now() WHERE id = :id"),
            {"r": new_role, "id": uid},
        )
        await write_audit(conn, admin, "user.role_change", "user", str(uid),
                          {"from": target.role, "to": new_role})  # fmt: skip
    # Takes effect at the target's next token refresh (≤ 15 min); the admin API re-checks now.
    return {"ok": True, "role": new_role}


@router.patch("/users/{user_id}/status")
async def change_status(user_id: str, request: Request, admin: CurrentAdmin, db: Db) -> Any:
    uid = path_id(user_id, _NOT_FOUND)
    disable = parse_status(await json_object(request))
    async with db.role_transaction(SERVICE) as conn:
        count = await lock_admin_count(conn, admin, uid)
        target = await _target(conn, uid)
        if disable:
            guard_disable(admin.user_id, uid, target.role, count)
        await _set_disabled(conn, uid, disable)
        await write_audit(conn, admin, "user.disable" if disable else "user.enable", "user",
                          str(uid))  # fmt: skip
    return {"ok": True, "disabled": disable}


async def _set_disabled(conn: AsyncConnection, uid: uuid.UUID, disable: bool) -> None:
    await conn.execute(
        text(
            "UPDATE public.users SET disabled_at = CASE WHEN :d THEN COALESCE(disabled_at, now()) "
            "ELSE NULL END, updated_at = now() WHERE id = :id"
        ),
        {"d": disable, "id": uid},
    )
    if disable:
        await auth_service.revoke_user_tokens(conn, uid)  # every session ends


@router.post("/users/{user_id}/reset-password")
async def send_password_reset(
    user_id: str, admin: CurrentAdmin, db: Db, runtime: Runtime
) -> dict[str, Any]:
    """Mails the user a reset link (v1 ``generateLink('recovery')``); never sets a password.
    ``email_sent: false`` when mail is not configured or sending failed."""
    uid = path_id(user_id, _NOT_FOUND)
    async with db.role_transaction(SERVICE) as conn:
        target = await _target(conn, uid)
        # The same per-address limit as /auth/forgot-password (3/h): no mail-bombing a user.
        enforce(runtime.limiters.email_address, f"reset_password:{target.email.lower()}")
        token = await auth_service.issue_email_token(
            conn, uid, "reset_password", ttl=RESET_TTL, now=datetime.now(UTC)
        )
        await write_audit(conn, admin, "user.password_reset", "user", str(uid))
    sent = await send_mail(
        runtime, target.email, reset_password_email(link(runtime, "reset-password", token))
    )
    return {"ok": True, "email_sent": sent}


# --- delete ---------------------------------------------------------------------------------------


@router.delete("/users/{user_id}")
async def delete_user(user_id: str, admin: CurrentAdmin, db: Db, platform: Plat) -> Any:
    """Files first (CLAUDE.md §9c): the account is disabled and signed out, then every owned
    meeting audio and the avatar are deleted from Drive, each in its own step; a failure becomes
    ``storageWarnings`` and the user is still deleted. Rows cascade (meetings, folders, chat,
    quota, …; audit rows keep a NULL actor). Keys that appeared in between (an upload the user
    confirmed just before being disabled) get a second Drive pass after the row delete."""
    uid = path_id(user_id, _NOT_FOUND)
    async with db.role_transaction(SERVICE) as conn:
        count = await lock_admin_count(conn, admin, uid)
        target = await _target(conn, uid)
        guard_delete(admin.user_id, uid, target.role, count)
        await _set_disabled(conn, uid, True)  # no new uploads while the files go
        first = await _owned_keys(conn, uid)
    failed = await delete_files(db, platform, first)
    async with db.role_transaction(SERVICE) as conn:
        count = await lock_admin_count(conn, admin, uid)  # re-checked: the target may have changed
        target = await _target(conn, uid)
        guard_delete(admin.user_id, uid, target.role, count)
        late = [k for k in await _owned_keys(conn, uid) if k not in first]
        meetings = (
            await conn.execute(
                text("SELECT count(*) FROM public.meetings WHERE user_id = :u"), {"u": uid}
            )
        ).scalar_one()
        await conn.execute(text("DELETE FROM public.users WHERE id = :id"), {"id": uid})
        await write_audit(conn, admin, "user.delete", "user", str(uid),
                          {"meetings": meetings, "files": len(first) + len(late),
                           "files_failed": len(failed)})  # fmt: skip
    failed += await delete_files(db, platform, late)  # the map rows outlive the user
    out: dict[str, Any] = {"ok": True, "deleted": uid}
    if failed:
        out["storageWarnings"] = [f"Storage cleanup failed for {len(failed)} file(s)."]
    return out


async def _owned_keys(conn: AsyncConnection, uid: uuid.UUID) -> list[str]:
    """The user's own meeting audio keys and avatar key (a forged path is never included)."""
    meetings = (
        await conn.execute(
            text("SELECT id, user_id, audio_path FROM public.meetings WHERE user_id = :u"),
            {"u": uid},
        )
    ).all()
    keys = [
        m.audio_path for m in meetings
        if m.audio_path and is_owned_audio_key(m.audio_path, str(m.user_id), str(m.id))
    ]  # fmt: skip
    avatar = (
        await conn.execute(text("SELECT avatar_key FROM public.profiles WHERE id = :u"), {"u": uid})
    ).scalar_one_or_none()
    if avatar and is_owned_avatar_key(avatar, str(uid)):
        keys.append(avatar)
    return keys


# --- bulk -----------------------------------------------------------------------------------------


@router.post("/users/bulk")
async def bulk_action(request: Request, admin: CurrentAdmin, db: Db) -> dict[str, Any]:
    """``{ids ≤ 50, action: disable|enable|set_role, role?}``; the caller is always skipped
    (v1). All or nothing: one transaction (ids locked in sorted order) and one audit row for the
    batch; unknown ids are reported. Promotion needs an active, verified account."""
    ids, action, role = parse_bulk(await json_object(request))
    safe, self_skipped = exclude_self(admin.user_id, ids)
    processed: list[uuid.UUID] = []
    errors: list[dict[str, Any]] = []
    if safe:
        async with db.role_transaction(SERVICE) as conn:
            for uid in sorted(safe):
                count = await lock_admin_count(conn, admin, uid)
                row = (
                    await conn.execute(
                        text(
                            "SELECT role, disabled_at, email_verified_at FROM public.users "
                            "WHERE id = :id FOR NO KEY UPDATE"
                        ),
                        {"id": uid},
                    )
                ).first()
                if row is None:
                    errors.append({"id": uid, "message": _NOT_FOUND})
                    continue
                if action == "set_role" and role is not None:
                    guard_role_change(admin.user_id, uid, row.role, role, count)
                    guard_promotion(role, _status(row))
                    await conn.execute(
                        text(
                            "UPDATE public.users SET role = :r, updated_at = now() WHERE id = :id"
                        ),
                        {"r": role, "id": uid},
                    )
                else:
                    if action == "disable":
                        guard_disable(admin.user_id, uid, row.role, count)
                    await _set_disabled(conn, uid, action == "disable")
                processed.append(uid)
            await write_audit(conn, admin, f"user.bulk_{action}", "user",
                              str(processed[0]) if processed else "bulk",
                              {"action": action, "role": role, "processed": len(processed),
                               "ids": [str(i) for i in processed],
                               "errors": len(errors)})  # fmt: skip
    out: dict[str, Any] = {"processed": len(processed)}
    if errors:
        out["errors"] = errors
    if self_skipped:
        out["skippedSelf"] = [admin.user_id]
    return out


# --- quota ----------------------------------------------------------------------------------------


@router.get("/users/{user_id}/quota")
async def get_quota(user_id: str, admin: CurrentAdmin, db: Db) -> dict[str, Any]:
    uid = path_id(user_id, _NOT_FOUND)
    async with db.role_transaction(SERVICE) as conn:
        if (
            await conn.execute(text("SELECT 1 FROM public.users WHERE id = :id"), {"id": uid})
        ).first() is None:
            raise NotFound(_NOT_FOUND)
        wallet = (
            await conn.execute(
                text(
                    "SELECT audio_seconds_remaining, agent_queries_remaining, updated_at "
                    "FROM public.quota_wallets WHERE user_id = :u"
                ),
                {"u": uid},
            )
        ).first()
        ledger = (
            await conn.execute(
                text(
                    "SELECT id, created_at, reason, delta_audio_seconds, delta_agent_queries, "
                    "created_by, metadata FROM public.quota_ledger WHERE user_id = :u "
                    "ORDER BY created_at DESC, id DESC LIMIT 20"
                ),
                {"u": uid},
            )
        ).all()
    return {
        "wallet": {
            "audio_seconds_remaining": int(wallet[0]) if wallet else 0,
            "agent_queries_remaining": int(wallet[1]) if wallet else 0,
            "updated_at": wallet[2] if wallet else None,
        },
        "ledger": [
            {"id": r.id, "created_at": r.created_at, "reason": r.reason,
             "delta_audio_seconds": int(r.delta_audio_seconds),
             "delta_agent_queries": int(r.delta_agent_queries), "created_by": r.created_by,
             "metadata": jsonb(r.metadata) or {}}
            for r in ledger
        ],
    }  # fmt: skip


@router.post("/users/{user_id}/quota")
async def grant_quota(user_id: str, request: Request, admin: CurrentAdmin, db: Db) -> Any:
    """``{audio_minutes?, agent_queries?, note?}`` → an ``admin_grant`` ledger row (v1)."""
    uid = path_id(user_id, _NOT_FOUND)
    seconds, queries, note = parse_quota_grant(await json_object(request))
    grant_id = uuid.uuid4()
    async with db.role_transaction(SERVICE) as conn:
        exists = (
            await conn.execute(text("SELECT 1 FROM public.users WHERE id = :id"), {"id": uid})
        ).first()
        if exists is None:
            raise NotFound(_NOT_FOUND)
        result = (
            await conn.execute(
                text(
                    "SELECT status, audio_remaining, agent_remaining FROM "
                    "public.quota_apply_movement(:u, :a, :q, 'admin_grant', :k, true, NULL, "
                    ":by, CAST(:md AS jsonb))"
                ),
                {"u": uid, "a": seconds, "q": queries, "k": str(grant_id), "by": admin.user_id,
                 "md": json.dumps({"note": note, "grant_id": str(grant_id)})},
            )
        ).one()  # fmt: skip
        await write_audit(conn, admin, "quota.grant", "user", str(uid),
                          {"audio_minutes": seconds / 60, "agent_queries": queries,
                           "note": note, "grant_id": str(grant_id)})  # fmt: skip
    return {
        "ok": True,
        "grantId": grant_id,
        "audioRemaining": int(result.audio_remaining),
        "agentRemaining": int(result.agent_remaining),
    }
