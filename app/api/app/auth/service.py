"""Auth data access (ARC-05). Every function runs inside ``db.role_transaction('ricotdin_service')``
— the only role that can read ``users`` / ``refresh_tokens`` / ``email_tokens``.

Only token hashes are stored or compared; plaintext tokens exist in memory and in the response
(cookie / email) only.
"""

import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.auth.tokens import (
    RefreshOutcome,
    RefreshRow,
    hash_token,
    new_opaque_token,
    refresh_outcome,
)
from app.core.logging import get_logger

log = get_logger("auth")

SIGNUP_AUDIO_SECONDS = 60 * 60  # v1 parity (register route)
SIGNUP_AGENT_QUERIES = 50
EmailPurpose = Literal["verify_email", "reset_password"]

_USER_COLUMNS = """
    u.id, u.email, u.password_hash, u.role, u.email_verified_at, u.disabled_at, p.username
"""


@dataclass(frozen=True)
class UserRow:
    id: uuid.UUID
    email: str
    password_hash: str
    role: str
    email_verified_at: datetime | None
    disabled_at: datetime | None
    username: str | None

    def __repr__(self) -> str:  # never print the hash
        return f"UserRow(id={self.id!s}, role={self.role!r})"

    def public(self) -> dict[str, Any]:
        return {
            "id": str(self.id),
            "email": self.email,
            "username": self.username,
            "role": self.role,
        }


def _user(row: Any) -> UserRow | None:
    return None if row is None else UserRow(**row._mapping)


async def find_user_by_email(conn: AsyncConnection, email: str) -> UserRow | None:
    r = await conn.execute(
        text(
            f"SELECT {_USER_COLUMNS} FROM users u LEFT JOIN profiles p ON p.id = u.id "  # noqa: S608
            "WHERE lower(u.email) = :email"
        ),
        {"email": email},
    )
    return _user(r.first())


async def find_user_by_username(conn: AsyncConnection, username: str) -> UserRow | None:
    r = await conn.execute(
        text(
            f"SELECT {_USER_COLUMNS} FROM profiles p JOIN users u ON u.id = p.id "  # noqa: S608
            "WHERE p.username = :username"
        ),
        {"username": username},
    )
    return _user(r.first())


async def find_user_by_id(conn: AsyncConnection, user_id: uuid.UUID) -> UserRow | None:
    r = await conn.execute(
        text(
            f"SELECT {_USER_COLUMNS} FROM users u LEFT JOIN profiles p ON p.id = u.id "  # noqa: S608
            "WHERE u.id = :id"
        ),
        {"id": user_id},
    )
    return _user(r.first())


async def username_taken(conn: AsyncConnection, username: str) -> bool:
    r = await conn.execute(text("SELECT 1 FROM profiles WHERE username = :u"), {"u": username})
    return r.first() is not None


async def create_user(
    conn: AsyncConnection, email: str, username: str, password_hash: str
) -> uuid.UUID:
    """users + profiles (role forced to 'user'), then the signup quota grant (non-fatal)."""
    user_id: uuid.UUID = (
        await conn.execute(
            text(
                "INSERT INTO users (email, password_hash, role) "
                "VALUES (:e, :h, 'user') RETURNING id"
            ),
            {"e": email, "h": password_hash},
        )
    ).scalar_one()
    await conn.execute(
        text("INSERT INTO profiles (id, username, role) VALUES (:id, :u, 'user')"),
        {"id": user_id, "u": username},
    )
    try:
        async with conn.begin_nested():
            await conn.execute(
                text(
                    "SELECT quota_apply_movement(:id, :audio, :queries, 'admin_grant', :dedup, "
                    "true, NULL, NULL, CAST(:meta AS jsonb))"
                ),
                {
                    "id": user_id,
                    "audio": SIGNUP_AUDIO_SECONDS,
                    "queries": SIGNUP_AGENT_QUERIES,
                    "dedup": f"signup:{user_id}",
                    "meta": json.dumps({"source": "signup_initial_grant"}),
                },
            )
    except Exception as exc:  # noqa: BLE001 - v1 parity: a quota failure never blocks signup
        log.error(
            "signup quota grant failed",
            extra={"user_id": str(user_id), "error": type(exc).__name__},
        )
    return user_id


async def set_password_hash(conn: AsyncConnection, user_id: uuid.UUID, password_hash: str) -> None:
    await conn.execute(
        text("UPDATE users SET password_hash = :h WHERE id = :id"),
        {"h": password_hash, "id": user_id},
    )


async def mark_signed_in(conn: AsyncConnection, user_id: uuid.UUID) -> None:
    await conn.execute(
        text("UPDATE users SET last_sign_in_at = now() WHERE id = :id"), {"id": user_id}
    )


async def mark_email_verified(conn: AsyncConnection, user_id: uuid.UUID) -> None:
    await conn.execute(
        text(
            "UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = :id"
        ),
        {"id": user_id},
    )


async def log_activity(
    conn: AsyncConnection, user_id: uuid.UUID, event: str, ip: str | None, user_agent: str | None
) -> None:
    """activity_log row (§9g); best effort inside a savepoint so it never fails the request."""
    try:
        async with conn.begin_nested():
            await conn.execute(
                text(
                    "INSERT INTO activity_log (user_id, event_type, ip, user_agent) "
                    "VALUES (:u, :e, :ip, :ua)"
                ),
                {"u": user_id, "e": event, "ip": ip, "ua": (user_agent or "")[:512] or None},
            )
    except Exception as exc:  # noqa: BLE001
        log.error("activity log failed", extra={"event": event, "error": type(exc).__name__})


# --- refresh tokens ------------------------------------------------------------------------------


async def issue_refresh(
    conn: AsyncConnection,
    user_id: uuid.UUID,
    *,
    ttl: timedelta,
    now: datetime,
    family_id: uuid.UUID | None = None,
    ip: str | None = None,
    user_agent: str | None = None,
) -> tuple[str, uuid.UUID]:
    token = new_opaque_token()
    token_id: uuid.UUID = (
        await conn.execute(
            text(
                "INSERT INTO refresh_tokens "
                "(user_id, family_id, token_hash, expires_at, ip, user_agent) "
                "VALUES (:u, :f, :h, :exp, :ip, :ua) RETURNING id"
            ),
            {
                "u": user_id,
                "f": family_id or uuid.uuid4(),
                "h": hash_token(token),
                "exp": now + ttl,
                "ip": ip,
                "ua": (user_agent or "")[:512] or None,
            },
        )
    ).scalar_one()
    return token, token_id


@dataclass(frozen=True)
class RotateResult:
    outcome: RefreshOutcome
    user: UserRow | None = None
    token: str | None = None


async def revoke_user_tokens(conn: AsyncConnection, user_id: uuid.UUID) -> None:
    await conn.execute(
        text(
            "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = :u AND revoked_at IS NULL"
        ),
        {"u": user_id},
    )


async def revoke_family(conn: AsyncConnection, family_id: uuid.UUID) -> None:
    await conn.execute(
        text(
            "UPDATE refresh_tokens SET revoked_at = now() "
            "WHERE family_id = :f AND revoked_at IS NULL"
        ),
        {"f": family_id},
    )


async def rotate_refresh(
    conn: AsyncConnection,
    token: str,
    *,
    ttl: timedelta,
    now: datetime,
    ip: str | None,
    user_agent: str | None,
) -> RotateResult:
    """Exchange a refresh token for a new one. Revocations are written here and must be committed
    even when the caller answers 401 (do not raise inside the transaction)."""
    row = (
        await conn.execute(
            text(
                "SELECT t.id, t.user_id, t.family_id, t.revoked_at, t.expires_at, u.disabled_at "
                "FROM refresh_tokens t JOIN users u ON u.id = t.user_id "
                "WHERE t.token_hash = :h FOR UPDATE OF t"
            ),
            {"h": hash_token(token)},
        )
    ).first()
    state = (
        None
        if row is None
        else RefreshRow(row.revoked_at, row.expires_at, user_disabled=row.disabled_at is not None)
    )
    outcome = refresh_outcome(state, now)
    if row is None or outcome == "unknown":
        return RotateResult("unknown")
    if outcome == "reuse":
        log.warning(
            "refresh reuse detected, session family revoked", extra={"user_id": str(row.user_id)}
        )
        await revoke_family(conn, row.family_id)
        return RotateResult(outcome)
    if outcome == "disabled":
        await revoke_user_tokens(conn, row.user_id)
        return RotateResult(outcome)
    if outcome == "expired":
        await conn.execute(
            text("UPDATE refresh_tokens SET revoked_at = now() WHERE id = :id"), {"id": row.id}
        )
        return RotateResult(outcome)
    new_token, new_id = await issue_refresh(
        conn, row.user_id, ttl=ttl, now=now, family_id=row.family_id, ip=ip, user_agent=user_agent
    )
    await conn.execute(
        text("UPDATE refresh_tokens SET revoked_at = now(), replaced_by = :n WHERE id = :id"),
        {"n": new_id, "id": row.id},
    )
    return RotateResult("ok", await find_user_by_id(conn, row.user_id), new_token)


async def revoke_refresh_family_of(conn: AsyncConnection, token: str) -> uuid.UUID | None:
    """Logout: end the session the cookie belongs to. Returns its user, or None if unknown."""
    row = (
        await conn.execute(
            text("SELECT user_id, family_id FROM refresh_tokens WHERE token_hash = :h"),
            {"h": hash_token(token)},
        )
    ).first()
    if row is None:
        return None
    await revoke_family(conn, row.family_id)
    user_id: uuid.UUID = row.user_id
    return user_id


# --- email tokens --------------------------------------------------------------------------------


async def issue_email_token(
    conn: AsyncConnection,
    user_id: uuid.UUID,
    purpose: EmailPurpose,
    *,
    ttl: timedelta,
    now: datetime,
) -> str:
    """A new single-use token; earlier unused tokens of the same purpose stop working."""
    await conn.execute(
        text(
            "UPDATE email_tokens SET used_at = now() "
            "WHERE user_id = :u AND purpose = :p AND used_at IS NULL"
        ),
        {"u": user_id, "p": purpose},
    )
    token = new_opaque_token()
    await conn.execute(
        text(
            "INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at) "
            "VALUES (:u, :p, :h, :exp)"
        ),
        {"u": user_id, "p": purpose, "h": hash_token(token), "exp": now + ttl},
    )
    return token


async def consume_email_token(
    conn: AsyncConnection, token: str, purpose: EmailPurpose, *, now: datetime
) -> uuid.UUID | None:
    r = await conn.execute(
        text(
            "UPDATE email_tokens SET used_at = now() "
            "WHERE token_hash = :h AND purpose = :p AND used_at IS NULL AND expires_at > :now "
            "RETURNING user_id"
        ),
        {"h": hash_token(token), "p": purpose, "now": now},
    )
    user_id: uuid.UUID | None = r.scalar_one_or_none()
    return user_id
