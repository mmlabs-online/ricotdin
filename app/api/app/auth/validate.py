"""Auth input validation (ARC-05; port of v1 ``lib/auth/validate.ts``). Pure.

Each validator returns ``None`` when valid, or a user-facing message.
"""

import re
from dataclasses import dataclass
from typing import Literal

_USERNAME = re.compile(r"^[a-z0-9_-]+$")
# One plain address: no display names, quotes, comments or lists (recipient injection, ARC-05).
_EMAIL = re.compile(
    r"^[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$"
)
MIN_PASSWORD = 8
MAX_PASSWORD = 256  # bounds hashing work per request


def normalize_username(raw: str) -> str:
    return raw.lower().strip()


def normalize_email(raw: str) -> str:
    return raw.strip().lower()


def validate_username(username: str) -> str | None:
    if len(username) < 3:
        return "Username must be at least 3 characters."
    if len(username) > 30:
        return "Username must be at most 30 characters."
    if not _USERNAME.match(username):
        return "Username may only contain lowercase letters, digits, hyphens, and underscores."
    return None


def validate_email(email: str) -> str | None:
    """Shape only; the verification email proves ownership."""
    if len(email) > 254 or not _EMAIL.match(email) or ".." in email:
        return "Enter a valid email address."
    return None


def validate_password(password: str) -> str | None:
    if len(password) < MIN_PASSWORD:
        return f"Password must be at least {MIN_PASSWORD} characters."
    if len(password) > MAX_PASSWORD:
        return f"Password must be at most {MAX_PASSWORD} characters."
    return None


# --- registering an email that already has an account (SEC-05) --------------------------------


@dataclass(frozen=True)
class EmailState:
    verified: bool
    disabled: bool


RegistrationAction = Literal["create", "resend", "conflict"]


def registration_action(existing: EmailState | None) -> RegistrationAction:
    """An unverified account does not block its address: the inbox owner gets a fresh verify link
    (which sets the password) and the answer looks like a new registration. A verified or disabled
    account keeps the 409 (owner decision 2026-10-26)."""
    if existing is None:
        return "create"
    if existing.verified or existing.disabled:
        return "conflict"
    return "resend"
