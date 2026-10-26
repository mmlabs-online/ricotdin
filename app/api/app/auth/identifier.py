"""Login identifier: email or username (ARC-05, §9b). Pure.

The username → email lookup happens server-side only; the mapping is never returned.
"""

from dataclasses import dataclass
from typing import Literal

from app.auth.validate import normalize_email, normalize_username


@dataclass(frozen=True)
class Identifier:
    kind: Literal["email", "username"]
    value: str


def classify_identifier(raw: str) -> Identifier | None:
    trimmed = raw.strip()
    if not trimmed:
        return None
    if "@" in trimmed:
        return Identifier("email", normalize_email(trimmed))
    return Identifier("username", normalize_username(trimmed))
