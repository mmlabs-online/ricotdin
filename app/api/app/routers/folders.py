"""Folders, folder shares and user lookup (ARC-07).

Runs as ``ricotdin_service`` with the access checks in code, like v1 (which used the service role).
This also sidesteps the v1 ``folders_select`` policy bug carried into the baseline (grantees cannot
read a shared ``folders`` row under RLS, CLAUDE.md §0.1). Status codes follow v1: folder PATCH /
DELETE answer 404 to anyone but the owner; the share routes answer 403 when the folder exists.
"""

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy import Integer, bindparam, text
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection

from app.auth.deps import current_identity
from app.core.errors import Conflict, Forbidden, NotFound
from app.core.logging import get_logger
from app.core.ratelimit import RateLimiter
from app.db.context import RequestIdentity
from app.db.session import Database, get_database
from app.domain.rules import (
    is_email_identifier,
    normalize_lookup_username,
    parse_folder_name,
    parse_lookup,
    parse_reorder,
    parse_share_create,
    parse_share_role,
    parse_uuid,
)
from app.routers._common import (
    SERVICE,
    as_dict,
    as_dicts,
    enforce_limit,
    is_unique_violation,
    json_object,
    path_id,
)
from app.routers.meetings import delete_files
from app.routers.meetings import record_activity as meeting_activity
from app.services.platform import Platform, get_platform
from app.services.storage.ownership import is_owned_audio_key

router = APIRouter(tags=["folders"])
log = get_logger("folders")

Identity = Annotated[RequestIdentity, Depends(current_identity)]
Db = Annotated[Database, Depends(get_database)]

FOLDER_COLUMNS = "id, user_id, name, position, created_at, updated_at"
_FOLDER_NOT_FOUND = "Folder not found."
_INVALID_JSON = "Invalid JSON."


LOOKUPS_PER_15_MIN = 20


def lookup_limiter() -> RateLimiter:
    """Email → account lookups (``/users/lookup`` and adding a share) per user: v2 searches every
    user, so without a limit it would be an enumeration oracle."""
    return RateLimiter(capacity=LOOKUPS_PER_15_MIN, refill_per_second=LOOKUPS_PER_15_MIN / 900)


def _duplicate(name: str) -> Conflict:
    return Conflict(f'A folder named "{name}" already exists.')


@router.get("/folders")
async def list_folders(identity: Identity, db: Db) -> dict[str, list[dict[str, Any]]]:
    """Own folders (by position, then name) followed by folders shared with the caller (by name)."""
    me = identity.user_id
    async with db.role_transaction(SERVICE) as conn:
        owned = as_dicts(
            (
                await conn.execute(
                    text(
                        f"SELECT {FOLDER_COLUMNS}, "  # noqa: S608 - fixed column list
                        "(SELECT count(*) FROM public.folder_shares s WHERE s.folder_id = f.id) "
                        "AS member_count FROM public.folders f WHERE user_id = :me "
                        "ORDER BY position ASC, name ASC"
                    ),
                    {"me": me},
                )
            ).all()
        )
        shared = as_dicts(
            (
                await conn.execute(
                    text(
                        "SELECT f.id, f.user_id, f.name, f.position, f.created_at, f.updated_at, "
                        "s.role, p.username AS owner_username "
                        "FROM public.folder_shares s JOIN public.folders f ON f.id = s.folder_id "
                        "LEFT JOIN public.profiles p ON p.id = f.user_id "
                        "WHERE s.user_id = :me ORDER BY f.name ASC"
                    ),
                    {"me": me},
                )
            ).all()
        )
    folders = [
        {
            **{k: v for k, v in f.items() if k != "member_count"},
            "myRole": "owner",
            "ownerUsername": None,
            "memberCount": int(f["member_count"]),
        }
        for f in owned
    ]
    folders += [
        {
            **{k: v for k, v in f.items() if k not in ("role", "owner_username")},
            "myRole": f["role"] or "viewer",
            "ownerUsername": f["owner_username"],
            "memberCount": 0,
        }
        for f in shared
    ]
    return {"folders": folders}


@router.post("/folders", status_code=201)
async def create_folder(request: Request, identity: Identity, db: Db) -> JSONResponse:
    name = parse_folder_name(await json_object(request, _INVALID_JSON))
    try:
        async with db.role_transaction(SERVICE) as conn:
            row = (
                await conn.execute(
                    text(
                        "INSERT INTO public.folders (user_id, name, position) VALUES (:me, :name, "  # noqa: S608 - fixed column list
                        "(SELECT coalesce(max(position), -1) + 1 FROM public.folders "
                        "WHERE user_id = :me)) RETURNING " + FOLDER_COLUMNS
                    ),
                    {"me": identity.user_id, "name": name},
                )
            ).first()
    except IntegrityError as exc:
        if is_unique_violation(exc):
            raise _duplicate(name) from None
        raise
    folder = {**(as_dict(row) or {}), "myRole": "owner", "ownerUsername": None, "memberCount": 0}
    return JSONResponse(status_code=201, content={"folder": jsonable_encoder(folder)})


@router.patch("/folders/{folder_id}")
async def rename_folder(
    folder_id: str, request: Request, identity: Identity, db: Db
) -> dict[str, Any]:
    name = parse_folder_name(await json_object(request, _INVALID_JSON))
    fid = path_id(folder_id, _FOLDER_NOT_FOUND)
    try:
        async with db.role_transaction(SERVICE) as conn:
            row = (
                await conn.execute(
                    text(
                        "UPDATE public.folders SET name = :name, updated_at = now() "  # noqa: S608 - fixed column list
                        "WHERE id = :id AND user_id = :me RETURNING " + FOLDER_COLUMNS
                    ),
                    {"name": name, "id": fid, "me": identity.user_id},
                )
            ).first()
    except IntegrityError as exc:
        if is_unique_violation(exc):
            raise _duplicate(name) from None
        raise
    folder = as_dict(row)
    if folder is None:
        raise NotFound(_FOLDER_NOT_FOUND)
    return {"folder": folder}


@router.delete("/folders/{folder_id}")
async def delete_folder(
    folder_id: str,
    request: Request,
    identity: Identity,
    db: Db,
    platform: Annotated[Platform, Depends(get_platform)],
    deleteMeetings: str | None = None,
) -> dict[str, bool]:
    """Keep path: everyone's meetings move to Uncategorized (FK SET NULL); shares and folder chats
    cascade. ``deleteMeetings=true`` also deletes the caller's own meetings in the folder (never
    an editor's, BUG-011), each one's audio first; a storage failure does not stop the delete."""
    fid = path_id(folder_id, _FOLDER_NOT_FOUND)
    meetings: list[tuple[uuid.UUID, str | None]] = []
    async with db.role_transaction(SERVICE) as conn:
        owned = await conn.execute(
            text("SELECT 1 FROM public.folders WHERE id = :id AND user_id = :me FOR UPDATE"),
            {"id": fid, "me": identity.user_id},
        )
        if owned.first() is None:
            raise NotFound(_FOLDER_NOT_FOUND)
        if deleteMeetings != "true":
            await conn.execute(text("DELETE FROM public.folders WHERE id = :id"), {"id": fid})
            return {"ok": True}
        rows = await conn.execute(
            text(
                "SELECT id, audio_path FROM public.meetings WHERE folder_id = :id AND user_id = :me"
            ),
            {"id": fid, "me": identity.user_id},
        )
        meetings = [(r.id, r.audio_path) for r in rows]
    keys = [
        key
        for mid, key in meetings
        if key and is_owned_audio_key(key, str(identity.user_id), str(mid))
    ]
    failed = await delete_files(db, platform, keys)
    if failed:
        log.warning("folder delete: %d audio file(s) could not be removed", len(failed))
    async with db.role_transaction(SERVICE) as conn:
        await conn.execute(
            text("DELETE FROM public.meetings WHERE id = ANY(:ids) AND user_id = :me").bindparams(
                bindparam("ids", type_=ARRAY(UUID(as_uuid=True)))
            ),
            {"ids": [m for m, _ in meetings], "me": identity.user_id},
        )
        await conn.execute(
            text("DELETE FROM public.folders WHERE id = :id AND user_id = :me"),
            {"id": fid, "me": identity.user_id},
        )
    for mid, _ in meetings:
        await meeting_activity(
            db, request, identity.user_id, "meeting_deleted", None, {"meeting_id": str(mid)}
        )
    return {"ok": True}


@router.put("/folders/reorder")
async def reorder_folders(request: Request, identity: Identity, db: Db) -> dict[str, bool]:
    """Positions follow the array order; ids the caller does not own are skipped silently (v1)."""
    order = parse_reorder(await json_object(request, _INVALID_JSON))
    if not order:
        return {"ok": True}
    stmt = text(
        "UPDATE public.folders f SET position = o.pos, updated_at = now() "
        "FROM unnest(:ids, :positions) AS o(id, pos) "
        "WHERE f.id = o.id AND f.user_id = :me"
    ).bindparams(
        bindparam("ids", type_=ARRAY(UUID(as_uuid=True))),
        bindparam("positions", type_=ARRAY(Integer())),
    )
    params = {"ids": [i for i, _ in order], "positions": [p for _, p in order]}
    async with db.role_transaction(SERVICE) as conn:
        await conn.execute(stmt, {**params, "me": identity.user_id})
    return {"ok": True}


# --- shares -----------------------------------------------------------------------------------


async def _owned_folder(conn: AsyncConnection, folder_id: uuid.UUID, me: uuid.UUID) -> uuid.UUID:
    """The folder's owner id; 404 if it does not exist, 403 if the caller does not own it."""
    owner = (
        await conn.execute(
            text("SELECT user_id FROM public.folders WHERE id = :id"), {"id": folder_id}
        )
    ).scalar_one_or_none()
    if owner is None:
        raise NotFound(_FOLDER_NOT_FOUND)
    if owner != me:
        raise Forbidden("Forbidden.")
    return me


@router.get("/folders/{folder_id}/shares")
async def list_shares(
    folder_id: str, identity: Identity, db: Db
) -> dict[str, list[dict[str, Any]]]:
    fid = path_id(folder_id, _FOLDER_NOT_FOUND)
    async with db.role_transaction(SERVICE) as conn:
        await _owned_folder(conn, fid, identity.user_id)
        rows = (
            await conn.execute(
                text(
                    "SELECT s.user_id, s.role, p.username FROM public.folder_shares s "
                    "LEFT JOIN public.profiles p ON p.id = s.user_id "
                    "WHERE s.folder_id = :id ORDER BY s.created_at ASC"
                ),
                {"id": fid},
            )
        ).all()
    return {
        "members": [
            {"userId": str(r.user_id), "username": r.username or str(r.user_id), "role": r.role}
            for r in rows
        ]
    }


async def _resolve_user(conn: AsyncConnection, identifier: str) -> tuple[uuid.UUID, str | None]:
    """Email (any '@') via ``users``, else username via ``profiles``. Never returns the email."""
    if is_email_identifier(identifier):
        row = (
            await conn.execute(
                text(
                    "SELECT u.id, p.username FROM public.users u "
                    "LEFT JOIN public.profiles p ON p.id = u.id WHERE lower(u.email) = lower(:e)"
                ),
                {"e": identifier.strip()},
            )
        ).first()
        if row is None:
            raise NotFound("No account found with that email.")
    else:
        row = (
            await conn.execute(
                text("SELECT id, username FROM public.profiles WHERE username = :u"),
                {"u": normalize_lookup_username(identifier)},
            )
        ).first()
        if row is None:
            raise NotFound("No account found with that username.")
    return row[0], row[1]


@router.post("/folders/{folder_id}/shares", status_code=201)
async def add_share(folder_id: str, request: Request, identity: Identity, db: Db) -> JSONResponse:
    identifier, role = parse_share_create(await json_object(request))
    fid = path_id(folder_id, _FOLDER_NOT_FOUND)
    try:
        async with db.role_transaction(SERVICE) as conn:
            await _owned_folder(conn, fid, identity.user_id)
            enforce_limit(request.app.state.lookup_limiter, identity.user_id)
            grantee, username = await _resolve_user(conn, identifier)
            if grantee == identity.user_id:
                raise Conflict("You cannot share a folder with yourself.")
            await conn.execute(
                text(
                    "INSERT INTO public.folder_shares (folder_id, user_id, role, invited_by) "
                    "VALUES (:f, :u, :r, :me)"
                ),
                {"f": fid, "u": grantee, "r": role, "me": identity.user_id},
            )
    except IntegrityError as exc:
        if is_unique_violation(exc):
            raise Conflict("That user is already a member of this folder.") from None
        raise
    member = {"userId": str(grantee), "username": username or str(grantee), "role": role}
    return JSONResponse(status_code=201, content={"member": member})


@router.patch("/folders/{folder_id}/shares/{grantee_id}")
async def change_share(
    folder_id: str, grantee_id: str, request: Request, identity: Identity, db: Db
) -> dict[str, Any]:
    role = parse_share_role(await json_object(request))
    fid = path_id(folder_id, _FOLDER_NOT_FOUND)
    grantee = parse_uuid(grantee_id)
    async with db.role_transaction(SERVICE) as conn:
        await _owned_folder(conn, fid, identity.user_id)
        if grantee is not None:  # v1 answers 200 even when nobody matched
            await conn.execute(
                text(
                    "UPDATE public.folder_shares SET role = :r "
                    "WHERE folder_id = :f AND user_id = :u"
                ),
                {"r": role, "f": fid, "u": grantee},
            )
    return {"ok": True, "role": role}


@router.delete("/folders/{folder_id}/shares/{grantee_id}")
async def remove_share(
    folder_id: str, grantee_id: str, identity: Identity, db: Db
) -> dict[str, bool]:
    """The folder owner removes anyone; a grantee may remove themselves (leave)."""
    fid = path_id(folder_id, _FOLDER_NOT_FOUND)
    grantee = parse_uuid(grantee_id)
    async with db.role_transaction(SERVICE) as conn:
        owner = (
            await conn.execute(
                text("SELECT user_id FROM public.folders WHERE id = :id"), {"id": fid}
            )
        ).scalar_one_or_none()
        if owner is None:
            raise NotFound(_FOLDER_NOT_FOUND)
        if owner != identity.user_id and grantee != identity.user_id:
            raise Forbidden("Forbidden.")
        if grantee is not None:
            await conn.execute(
                text("DELETE FROM public.folder_shares WHERE folder_id = :f AND user_id = :u"),
                {"f": fid, "u": grantee},
            )
    return {"ok": True}


@router.post("/users/lookup")
async def lookup_user(request: Request, identity: Identity, db: Db) -> dict[str, Any]:
    identifier = parse_lookup(await json_object(request))
    enforce_limit(request.app.state.lookup_limiter, identity.user_id)
    async with db.role_transaction(SERVICE) as conn:
        user_id, username = await _resolve_user(conn, identifier)
    return {"id": str(user_id), "username": username}
