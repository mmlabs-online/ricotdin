"""Shared admin plumbing (ARC-10): the admin identity and the audit row.

``current_admin`` accepts a token with role ``admin`` AND re-reads ``users`` on every request:
the account must still be an admin and not disabled. A demoted or disabled admin loses the admin
API at once instead of when the access token expires (≤ 15 min, CLAUDE.md §0.3).

``write_audit`` inserts the ``audit_logs`` row in the caller's transaction, so a mutation and its
audit row commit together (v1 wrote it fire-and-forget after the change). Metadata holds ids,
counts and field names only — never meeting content, keys or secrets.
"""

import json
import uuid
from dataclasses import dataclass
from typing import Annotated, Any

from fastapi import Depends, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.auth.deps import client_ip, require_admin
from app.core.errors import Forbidden
from app.db.context import RequestIdentity
from app.db.session import Database, get_database
from app.routers._common import SERVICE


@dataclass(frozen=True)
class Admin:
    user_id: uuid.UUID
    email: str
    ip: str | None
    user_agent: str | None


async def current_admin(
    request: Request,
    identity: Annotated[RequestIdentity, Depends(require_admin)],
    db: Annotated[Database, Depends(get_database)],
) -> Admin:
    async with db.role_transaction(SERVICE) as conn:
        row = (
            await conn.execute(
                text("SELECT email, role, disabled_at FROM public.users WHERE id = :id"),
                {"id": identity.user_id},
            )
        ).first()
    if row is None or row.role != "admin" or row.disabled_at is not None:
        raise Forbidden(detail="admin token for an account that is no longer an active admin")
    return Admin(
        identity.user_id,
        row.email,
        client_ip(request),
        (request.headers.get("user-agent") or "")[:512] or None,
    )


CurrentAdmin = Annotated[Admin, Depends(current_admin)]


async def write_audit(
    conn: AsyncConnection,
    admin: Admin,
    action: str,
    target_type: str,
    target_id: str,
    metadata: dict[str, Any] | None = None,
) -> None:
    await conn.execute(
        text(
            "INSERT INTO public.audit_logs (actor_id, actor_email, action, target_type, "
            "target_id, metadata, ip_address, user_agent) "
            "VALUES (:a, :e, :act, :tt, :tid, CAST(:md AS jsonb), :ip, :ua)"
        ),
        {"a": admin.user_id, "e": admin.email, "act": action, "tt": target_type,
         "tid": target_id, "md": json.dumps(metadata or {}), "ip": admin.ip,
         "ua": admin.user_agent},
    )  # fmt: skip


async def lock_admin_count(conn: AsyncConnection, admin: Admin, target: uuid.UUID) -> int:
    """Active admins, plus the target if it is a disabled admin, with their rows locked so two
    concurrent changes cannot remove the last admin between them. The caller must be among them
    (re-checked inside the mutation's transaction, so an admin demoted a moment ago is refused).

    ``FOR NO KEY UPDATE`` serialises admin changes against each other but, unlike ``FOR UPDATE``,
    does not block the foreign-key checks of the users' own inserts (a refresh token rotation,
    a meeting, a usage row), which would otherwise deadlock with a disable.
    """
    rows = (
        await conn.execute(
            text(
                "SELECT id FROM public.users WHERE role = 'admin' "
                "AND (disabled_at IS NULL OR id = :t) ORDER BY id FOR NO KEY UPDATE"
            ),
            {"t": target},
        )
    ).all()
    ids = {r[0] for r in rows}
    if admin.user_id not in ids:
        raise Forbidden(detail="caller is no longer an active admin")
    return len(rows)
