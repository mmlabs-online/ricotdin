"""User data access for the mmlabs sign-in (ARC-05, AUT-05/06). Every function runs inside
``db.role_transaction('ricotdin_service')``, the only role that can read ``users``."""

import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.logging import get_logger

log = get_logger("auth")

SIGNUP_AUDIO_SECONDS = 60 * 60  # v1 parity (register route)
SIGNUP_AGENT_QUERIES = 50

_USER_COLUMNS = """
    u.id, u.email, u.password_hash, u.role, u.email_verified_at, u.disabled_at, p.username
"""


@dataclass(frozen=True)
class UserRow:
    id: uuid.UUID
    email: str
    password_hash: str | None  # NULL for accounts that only sign in with mmlabs (AUT-05)
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
    return await username_owner(conn, username) is not None


async def username_owner(conn: AsyncConnection, username: str) -> uuid.UUID | None:
    r = await conn.execute(text("SELECT id FROM profiles WHERE username = :u"), {"u": username})
    owner: uuid.UUID | None = r.scalar()
    return owner


async def create_user(
    conn: AsyncConnection,
    email: str,
    username: str,
    password_hash: str | None,
    *,
    mmlabs_sub: str | None = None,
) -> uuid.UUID:
    """users + profiles (role forced to 'user'), then the signup quota grant (non-fatal).
    An mmlabs account (AUT-05) has no password here and a verified email (mmlabs checked it)."""
    user_id: uuid.UUID = (
        await conn.execute(
            text(
                "INSERT INTO users (email, password_hash, role, mmlabs_sub, email_verified_at) "
                "VALUES (:e, :h, 'user', CAST(:s AS text), "
                "CASE WHEN CAST(:s AS text) IS NULL THEN NULL ELSE now() END) "
                "RETURNING id"
            ),
            {"e": email, "h": password_hash, "s": mmlabs_sub},
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


# --- refresh tokens ------------------------------------------------------------------------------


async def revoke_user_tokens(conn: AsyncConnection, user_id: uuid.UUID) -> None:
    await conn.execute(
        text(
            "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = :u AND revoked_at IS NULL"
        ),
        {"u": user_id},
    )


# --- email tokens --------------------------------------------------------------------------------
