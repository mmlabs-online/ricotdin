"""Opaque refresh / email tokens and the refresh decision (ARC-05). Pure.

Only ``hash_token(token)`` is stored. Refresh tokens rotate on every use; presenting one that was
already rotated (revoked) means it was copied, so its whole family is revoked.
"""

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

RefreshOutcome = Literal["ok", "unknown", "reuse", "expired", "disabled"]


def new_opaque_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def is_expired(expires_at: datetime, now: datetime) -> bool:
    return expires_at <= now


def should_revoke_family(revoked_at: datetime | None) -> bool:
    return revoked_at is not None


@dataclass(frozen=True)
class RefreshRow:
    revoked_at: datetime | None
    expires_at: datetime
    user_disabled: bool


def refresh_outcome(row: RefreshRow | None, now: datetime) -> RefreshOutcome:
    if row is None:
        return "unknown"
    if should_revoke_family(row.revoked_at):
        return "reuse"
    if row.user_disabled:
        return "disabled"
    if is_expired(row.expires_at, now):
        return "expired"
    return "ok"
