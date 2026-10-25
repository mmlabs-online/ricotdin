"""Per-transaction RLS request context (ARC-04, CLAUDE.md §0.1 R3–R5). Pure.

Every API request transaction starts with these statements: switch to ``ricotdin_app`` (the
login is NOINHERIT, so it has no privileges before this) and set ``app.user_id`` / ``app.role``
transaction-locally with bind parameters. Values come only from the verified identity (ARC-05).
"""

import uuid
from dataclasses import dataclass
from typing import Any

APP_ROLE = "ricotdin_app"
_ROLES = {"user", "admin"}


class InvalidRequestContext(ValueError):
    """The identity cannot be turned into an RLS context (never set a partial context)."""


@dataclass(frozen=True)
class RequestIdentity:
    user_id: uuid.UUID
    role: str  # 'user' | 'admin', from users.role via the verified token


def rls_context_statements(identity: RequestIdentity) -> list[tuple[str, dict[str, Any]]]:
    if not isinstance(identity.user_id, uuid.UUID):
        raise InvalidRequestContext("user_id must be a UUID")
    if identity.role not in _ROLES:
        raise InvalidRequestContext(f"role must be one of {sorted(_ROLES)}")
    return [
        (f"SET LOCAL ROLE {APP_ROLE}", {}),
        ("SELECT set_config('app.user_id', :user_id, true)", {"user_id": str(identity.user_id)}),
        ("SELECT set_config('app.role', :role, true)", {"role": identity.role}),
    ]
