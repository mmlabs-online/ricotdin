"""Row transforms for the Supabase → Neon migration (ARC-03). Pure.

Values travel as Postgres text (``col::text`` on the source, ``%s::text::<type>`` on the
target), so nothing is rounded or re-encoded on the way.
"""

import json
from collections import defaultdict
from collections.abc import Mapping, Sequence
from typing import Any

ROLES = {"admin", "user"}

# Columns read from Supabase auth.users (timestamps as text, booleans typed).
AUTH_USER_COLUMNS = (
    "id",
    "email",
    "encrypted_password",
    "email_confirmed_at",
    "last_sign_in_at",
    "created_at",
    "updated_at",
    "raw_app_meta_data",
    "is_anonymous",
    "deleted_at",
)
# Target column order of public.users.
USER_COLUMNS = [
    "id",
    "email",
    "password_hash",
    "role",
    "email_verified_at",
    "disabled_at",
    "last_sign_in_at",
    "created_at",
    "updated_at",
]


class MigrationBlocked(Exception):
    """The source cannot be migrated as it is; nothing has been written."""


def _role(raw_meta: Any) -> str:
    try:
        meta = json.loads(raw_meta) if isinstance(raw_meta, str) else raw_meta
    except ValueError:
        return "user"
    role = meta.get("role") if isinstance(meta, dict) else None
    return role if isinstance(role, str) and role in ROLES else "user"


def _blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def map_auth_user(row: Mapping[str, Any], *, now: str) -> dict[str, str | None]:
    """One Supabase ``auth.users`` row → a ``public.users`` row.

    ``now`` is the source snapshot time (text). ``row["banned"]`` is ``banned_until > now()``,
    computed by the source query. The bcrypt hash is kept as is (ARC-05 rehashes it on the next
    login); the role comes only from ``raw_app_meta_data.role`` (never user metadata).
    """
    uid = str(row["id"])
    if row.get("is_anonymous"):
        raise MigrationBlocked(f"user {uid} is anonymous")
    if _blank(row.get("email")):
        raise MigrationBlocked(f"user {uid} has no email")
    created = row.get("created_at") or now
    disabled = row.get("deleted_at") or (now if row.get("banned") else None)
    return {
        "id": uid,
        "email": str(row["email"]),
        "password_hash": row.get("encrypted_password") or "",
        "role": _role(row.get("raw_app_meta_data")),
        "email_verified_at": row.get("email_confirmed_at"),
        "disabled_at": disabled,
        "last_sign_in_at": row.get("last_sign_in_at"),
        "created_at": created,
        "updated_at": row.get("updated_at") or created,
    }


def source_user_problems(rows: Sequence[Mapping[str, Any]]) -> list[str]:
    """Reasons the users cannot be migrated, naming user ids only (never an address)."""
    anonymous = [str(r["id"]) for r in rows if r.get("is_anonymous")]
    no_email = [str(r["id"]) for r in rows if not r.get("is_anonymous") and _blank(r.get("email"))]
    by_email: dict[str, list[str]] = defaultdict(list)
    for r in rows:
        if not r.get("is_anonymous") and not _blank(r.get("email")):
            by_email[str(r["email"]).strip().lower()].append(str(r["id"]))
    problems: list[str] = []
    if anonymous:
        problems.append(
            f"{len(anonymous)} anonymous user(s) — delete them in v1 first "
            f"(CLAUDE.md §9a.2): {', '.join(sorted(anonymous))}"
        )
    if no_email:
        problems.append(f"{len(no_email)} without email: {', '.join(sorted(no_email))}")
    for ids in sorted(sorted(v) for v in by_email.values() if len(v) > 1):
        problems.append(f"duplicate email (case-insensitive): {', '.join(ids)}")
    return problems


def map_row(table: str, row: Mapping[str, Any], columns: Sequence[str]) -> list[Any]:
    """Project a source row onto the target columns (v2 public tables equal v1, ARC-02)."""
    missing = [c for c in columns if c not in row]
    if missing:
        raise MigrationBlocked(f"source lacks {', '.join(f'{table}.{c}' for c in missing)}")
    return [row[c] for c in columns]
