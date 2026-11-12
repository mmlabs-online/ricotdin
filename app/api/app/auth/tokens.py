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


# A session (one refresh family) ends 90 days after sign-in, however often it is refreshed
# (owner decision 2026-11-09, SEC-05). The sliding refresh TTL still applies inside it.
ABSOLUTE_TTL = timedelta(days=90)


def refresh_expiry(
    now: datetime, ttl: timedelta, *, family_started_at: datetime | None
) -> datetime:
    """expires_at of a new refresh token: the sliding TTL, never past the family's 90 days."""
    sliding = now + ttl
    if family_started_at is None:
        return sliding
    return min(sliding, family_started_at + ABSOLUTE_TTL)


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
    family_started_at: datetime | None = None  # first token of the family = the sign-in (SEC-05)


def refresh_outcome(row: RefreshRow | None, now: datetime) -> RefreshOutcome:
    if row is None:
        return "unknown"
    if row.revoked_at is not None:
        if should_revoke_family(row.revoked_at, rotated=row.rotated, now=now):
            return "reuse"
        return "raced" if row.rotated else "revoked"
    if row.user_disabled:
        return "disabled"
    if is_expired(row.expires_at, now) or (
        row.family_started_at is not None and is_expired(row.family_started_at + ABSOLUTE_TTL, now)
    ):
        return "expired"
    return "ok"
