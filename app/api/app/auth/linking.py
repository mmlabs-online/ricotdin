"""mmlabs account → ricotdin user (AUT-05).

The mmlabs ``sub`` is stored in ``users.mmlabs_sub``. On the first request of an mmlabs account:
an unlinked ricotdin user with the same email (case-insensitive) is linked (owner decision
2026-11-16; mmlabs proved the address: ``email_verified`` is required), otherwise a new user +
profile is created. A user linked to another ``sub`` is never relinked. The role follows the
token on every request (``users.role`` is written when it differs, so the database functions and
the admin API that read it agree). All SQL runs as ``ricotdin_service`` (CLAUDE.md §0.1).
"""

import re
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Literal

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection

from app.auth import service
from app.auth.mmlabs import MmlabsClaims
from app.core.errors import Conflict, Forbidden

USERNAME_MIN, USERNAME_MAX = 3, 30
_INVALID = re.compile(r"[^a-z0-9_-]+")
_DASHES = re.compile(r"-{2,}")
MAX_USERNAME_TRIES = 50


class AccountDisabled(Forbidden):
    code = "account_disabled"
    message = "Your account has been disabled. Please contact an administrator."


class AccountLinkConflict(Conflict):
    code = "account_link_conflict"
    message = (
        "This email already belongs to a ricotdin account linked to another mmlabs account. "
        "Please contact an administrator."
    )


@dataclass(frozen=True)
class LinkDecision:
    kind: Literal["use", "link", "create", "conflict"]
    user_id: uuid.UUID | None


def base_username(email: str) -> str:
    """profiles.username rules: ``^[a-z0-9_-]{3,30}$``."""
    local = email.split("@", 1)[0].lower()
    name = _DASHES.sub("-", _INVALID.sub("-", local)).strip("-")
    name = name[:USERNAME_MAX].rstrip("-")
    if not name:
        return "user"
    return name.ljust(USERNAME_MIN, "0")


def username_candidates(email: str, limit: int) -> Iterator[str]:
    base = base_username(email)
    yield base
    for n in range(2, limit + 1):
        suffix = f"-{n}"
        yield base[: USERNAME_MAX - len(suffix)].rstrip("-") + suffix


def link_decision(
    by_sub: uuid.UUID | None, by_email: tuple[uuid.UUID, str | None] | None, sub: str
) -> LinkDecision:
    if by_sub is not None:
        return LinkDecision("use", by_sub)
    if by_email is None:
        return LinkDecision("create", None)
    user_id, linked = by_email
    if linked is None:
        return LinkDecision("link", user_id)
    if linked == sub:
        return LinkDecision("use", user_id)
    return LinkDecision("conflict", None)


def _constraint(exc: IntegrityError) -> str | None:
    """Name of the violated constraint (asyncpg exposes it on the original error)."""
    for err in (exc.orig, getattr(exc.orig, "__cause__", None)):
        name = getattr(err, "constraint_name", None)
        if isinstance(name, str):
            return name
    return None


@dataclass(frozen=True)
class _Row:
    id: uuid.UUID
    role: str
    disabled: bool


async def _by_sub(conn: AsyncConnection, sub: str) -> _Row | None:
    r = await conn.execute(
        text(
            "SELECT id, role, disabled_at IS NOT NULL AS disabled FROM users WHERE mmlabs_sub = :s"
        ),
        {"s": sub},
    )
    row = r.first()
    return None if row is None else _Row(row.id, row.role, row.disabled)


async def _link_or_create(conn: AsyncConnection, claims: MmlabsClaims) -> uuid.UUID:
    row = None
    if claims.email.isascii():  # never link through Unicode case folding (U+212A → "k")
        r = await conn.execute(
            text("SELECT id, mmlabs_sub FROM users WHERE lower(email) = :e FOR UPDATE"),
            {"e": claims.email},
        )
        row = r.first()
    decision = link_decision(None, None if row is None else (row.id, row.mmlabs_sub), claims.sub)
    if decision.kind == "conflict":
        raise AccountLinkConflict()
    if decision.kind == "use" and decision.user_id is not None:
        return decision.user_id
    if decision.kind == "link" and decision.user_id is not None:
        # From now on only mmlabs signs this account in: the ricotdin password (which may have
        # been chosen by whoever registered the address first, before the owner) and every
        # legacy session and email link die here (account pre-hijacking, review of AUT-05).
        await conn.execute(
            text(
                "UPDATE users SET mmlabs_sub = :s, password_hash = NULL, "
                "email_verified_at = coalesce(email_verified_at, now()) "
                "WHERE id = :id AND mmlabs_sub IS NULL"
            ),
            {"s": claims.sub, "id": decision.user_id},
        )
        await service.revoke_user_tokens(conn, decision.user_id)
        await conn.execute(
            text("UPDATE email_tokens SET used_at = now() WHERE user_id = :u AND used_at IS NULL"),
            {"u": decision.user_id},
        )
        return decision.user_id
    for username in username_candidates(claims.email, MAX_USERNAME_TRIES):
        if await service.username_taken(conn, username):
            continue
        try:
            async with conn.begin_nested():
                return await service.create_user(
                    conn, claims.email, username, None, mmlabs_sub=claims.sub
                )
        except IntegrityError as exc:
            if _constraint(exc) == "profiles_username_key":
                continue  # username taken meanwhile: try the next one
            raise  # email or sub taken meanwhile (concurrent first request): the caller re-reads
    raise Conflict("Could not choose a username for this account. Please contact an administrator.")


async def resolve_user(conn: AsyncConnection, claims: MmlabsClaims, role: str) -> uuid.UUID:
    """The ricotdin user of ``claims`` (linked or created on first use), with ``users.role``
    set to ``role``. Raises ``AccountDisabled`` / ``AccountLinkConflict``."""
    row = await _by_sub(conn, claims.sub)
    if row is None:
        try:
            async with conn.begin_nested():
                await _link_or_create(conn, claims)
        except IntegrityError:
            pass  # a concurrent first request linked or created it: read it back
        row = await _by_sub(conn, claims.sub)
        if row is None:
            raise AccountLinkConflict()
    if row.disabled:
        raise AccountDisabled()
    if row.role != role:
        await conn.execute(
            text("UPDATE users SET role = :r WHERE id = :id AND role IS DISTINCT FROM :r"),
            {"r": role, "id": row.id},
        )
    return row.id
