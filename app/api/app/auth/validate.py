"""Auth input validation (ARC-05; port of v1 ``lib/auth/validate.ts``). Pure.

Each validator returns ``None`` when valid, or a user-facing message.
"""

import re

_USERNAME = re.compile(r"^[a-z0-9_-]+$")
_FORBIDDEN_EMAIL_CHARS = re.compile(r"[\s\x00-\x1f\x7f]")
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
    """Basic shape only (v1 parity); the verification email proves ownership."""
    local, at, domain = email.rpartition("@")
    if not at or not local or not domain or len(email) > 254:
        return "Enter a valid email address."
    if _FORBIDDEN_EMAIL_CHARS.search(email):
        return "Enter a valid email address."
    return None


def validate_password(password: str) -> str | None:
    if len(password) < MIN_PASSWORD:
        return f"Password must be at least {MIN_PASSWORD} characters."
    if len(password) > MAX_PASSWORD:
        return f"Password must be at most {MAX_PASSWORD} characters."
    return None
