"""Username validation (ARC-05; port of v1 ``lib/auth/validate.ts``). Pure.

Returns ``None`` when valid, or a user-facing message. Passwords and emails are mmlabs' (AUT-06).
"""

import re

_USERNAME = re.compile(r"^[a-z0-9_-]+$")


def normalize_username(raw: str) -> str:
    return raw.lower().strip()


def validate_username(username: str) -> str | None:
    if len(username) < 3:
        return "Username must be at least 3 characters."
    if len(username) > 30:
        return "Username must be at most 30 characters."
    if not _USERNAME.match(username):
        return "Username may only contain lowercase letters, digits, hyphens, and underscores."
    return None
