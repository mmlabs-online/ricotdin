"""Auth input validation (ARC-05; port of v1 ``lib/auth/validate.ts``). Pure.

Each validator returns ``None`` when valid, or a user-facing message.
"""

import re

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
