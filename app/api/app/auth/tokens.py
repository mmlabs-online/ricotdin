"""Opaque refresh / email tokens and the refresh decision (ARC-05). Pure.

Only ``hash_token(token)`` is stored. Refresh tokens rotate on every use; presenting one that was
already rotated (revoked) means it was copied, so its whole family is revoked.
"""

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

RefreshOutcome = Literal["ok", "unknown", "reuse", "raced", "revoked", "expired", "disabled"]
# Two tabs (or a retried request) may present the same token right after it was rotated: that is
# a race, not theft. Answer 401 without revoking; the browser already holds the successor cookie.
REUSE_GRACE = timedelta(seconds=10)


def new_opaque_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def is_expired(expires_at: datetime, now: datetime) -> bool:
    return expires_at <= now


def should_revoke_family(revoked_at: datetime | None, *, rotated: bool, now: datetime) -> bool:
    """A token that was rotated (has a successor) presented again after the grace window was
    copied. Tokens revoked by logout / reset / expiry have no successor: just refuse them."""
    return rotated and revoked_at is not None and revoked_at <= now - REUSE_GRACE


@dataclass(frozen=True)
class RefreshRow:
    revoked_at: datetime | None
    expires_at: datetime
    user_disabled: bool
    rotated: bool = False  # replaced_by is set


def refresh_outcome(row: RefreshRow | None, now: datetime) -> RefreshOutcome:
    if row is None:
        return "unknown"
    if row.revoked_at is not None:
        if should_revoke_family(row.revoked_at, rotated=row.rotated, now=now):
            return "reuse"
        return "raced" if row.rotated else "revoked"
    if row.user_disabled:
        return "disabled"
    if is_expired(row.expires_at, now):
        return "expired"
    return "ok"
