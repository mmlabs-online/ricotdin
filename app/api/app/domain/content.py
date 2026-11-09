"""Editing a meeting's summary / notes with a version history (PRO-06). Pure.

Every version row holds the text a field had from that moment on, so the newest version of a
field is its current text. The first edit of a field first keeps the AI text it replaces."""

import hashlib
import re
import uuid
from dataclasses import dataclass
from typing import Any, Literal, cast

from app.core.errors import UnprocessableEntity

ContentField = Literal["summary", "notes"]
VersionSource = Literal["ai", "user", "restore"]

FIELDS: tuple[ContentField, ...] = ("summary", "notes")
MAX_CONTENT: dict[str, int] = {"summary": 20_000, "notes": 100_000}
MAX_VERSIONS = 50
_SOURCES = frozenset({"ai", "user", "restore"})
_HASH = re.compile(r"^[0-9a-f]{64}$")
# NUL cannot be stored in a Postgres text column; a lone surrogate cannot be encoded as UTF-8.
_BAD = re.compile("[\\x00\\ud800-\\udfff]")


class InvalidContentCharacters(UnprocessableEntity):
    code = "invalid_characters"


@dataclass(frozen=True)
class ContentEdit:
    field: ContentField
    content: str
    base_hash: str


def content_hash(text: str | None) -> str:
    """sha-256 hex of the UTF-8 text; NULL counts as empty. The client sends the hash of the text
    it started from, so a save over someone else's change is refused (409)."""
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def parse_content_field(raw: Any) -> ContentField:
    if raw == "summary":
        return "summary"
    if raw == "notes":
        return "notes"
    raise UnprocessableEntity("field must be one of: summary, notes.")


def _base_hash(body: dict[str, Any]) -> str:
    raw = body.get("baseHash")
    if not isinstance(raw, str) or not _HASH.fullmatch(raw):
        raise UnprocessableEntity("baseHash must be a lowercase sha-256 hex string.")
    return raw


def parse_content_edit(body: dict[str, Any]) -> ContentEdit:
    field = parse_content_field(body.get("field"))
    content = body.get("content")
    if not isinstance(content, str):
        raise UnprocessableEntity("content must be a string.")
    if len(content) > MAX_CONTENT[field]:
        raise UnprocessableEntity(f"{field} must be {MAX_CONTENT[field]} characters or fewer.")
    if _BAD.search(content):
        raise InvalidContentCharacters("The text contains characters that cannot be saved.")
    return ContentEdit(field, content, _base_hash(body))


def parse_restore(body: dict[str, Any]) -> str:
    return _base_hash(body)


def versions_to_write(
    *, has_history: bool, current: str | None, new: str, source: str
) -> list[tuple[str, VersionSource]]:
    """Version rows to insert, oldest first."""
    if source not in _SOURCES:
        raise ValueError(f"unknown version source {source!r}")
    rows: list[tuple[str, VersionSource]] = []
    if not has_history and current and current != new:
        rows.append((current, "ai"))  # before the first version, the text came from the AI
    rows.append((new, cast(VersionSource, source)))  # checked against _SOURCES above
    return rows


def versions_to_prune(ids_newest_first: list[uuid.UUID]) -> list[uuid.UUID]:
    return ids_newest_first[MAX_VERSIONS:]
