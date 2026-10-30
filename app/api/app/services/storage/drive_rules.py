"""Pure rules for the Google Drive backend (ARC-17): verifying a browser-uploaded file, HTTP
Range parsing, the retry policy, root-folder privacy and the media stream cap."""

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from app.core.errors import AppError
from app.services.storage.base import base_media_type

MAX_ATTEMPTS = 5
_MAX_DELAY_S = 32.0
_BASE_DELAY_S = 0.5
_RATE_LIMIT_REASONS = {"rateLimitExceeded", "userRateLimitExceeded"}
_FILE_ID = re.compile(r"[A-Za-z0-9_-]{10,200}")
_RANGE = re.compile(r"\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*", re.IGNORECASE)


class RangeNotSatisfiable(AppError):
    status = 416
    code = "range_not_satisfiable"
    message = "The requested range is not available."


@dataclass(frozen=True)
class ByteRange:
    start: int
    end: int  # inclusive

    @property
    def length(self) -> int:
        return self.end - self.start + 1

    @property
    def header(self) -> str:
        return f"bytes={self.start}-{self.end}"


def is_valid_file_id(file_id: str) -> bool:
    """Drive ids are URL-safe base64-ish; anything else never reaches a Drive URL."""
    return bool(file_id) and _FILE_ID.fullmatch(file_id) is not None


def verify_uploaded_file(
    meta: Mapping[str, Any],
    *,
    key: str,
    root_id: str,
    size: int,
    content_type: str,
    max_bytes: int,
) -> str | None:
    """None when the Drive file is the one the session was opened for, else a reason code."""
    props = meta.get("appProperties") or {}
    if not isinstance(props, Mapping) or props.get("key") != key:
        return "key_mismatch"
    if meta.get("parents") != [root_id]:
        return "parent_mismatch"
    if meta.get("trashed") is True:
        return "trashed"
    raw = meta.get("size")
    try:
        actual = int(raw) if isinstance(raw, str | int) else -1
    except ValueError:
        actual = -1
    if actual > max_bytes:
        return "too_large"
    if actual != size:
        return "size_mismatch"
    if base_media_type(str(meta.get("mimeType") or "")) != base_media_type(content_type):
        return "type_mismatch"
    return None


def parse_range(header: str | None, size: int) -> ByteRange | None:
    """A single satisfiable byte range, or None (absent/malformed/multi-range → full body).
    A well-formed range that starts past the end raises ``RangeNotSatisfiable`` (416)."""
    if not header:
        return None
    m = _RANGE.fullmatch(header)
    if m is None:
        return None
    first, last = m.group(1), m.group(2)
    if first:
        start = int(first)
        end = int(last) if last else size - 1
        if last and end < start:
            return None
        if start >= size:
            raise RangeNotSatisfiable(detail=f"range start {start} >= size {size}")
        return ByteRange(start, min(end, size - 1))
    if not last:
        return None
    suffix = int(last)
    if suffix == 0 or size == 0:
        return None
    return ByteRange(max(0, size - suffix), size - 1)


def content_range(rng: ByteRange, size: int) -> str:
    return f"bytes {rng.start}-{rng.end}/{size}"


def error_reason(body: Any) -> str | None:
    """``error.errors[0].reason`` of a Drive v3 error body."""
    if not isinstance(body, Mapping):
        return None
    err = body.get("error")
    if not isinstance(err, Mapping):
        return None
    errors = err.get("errors")
    if isinstance(errors, list) and errors and isinstance(errors[0], Mapping):
        reason = errors[0].get("reason")
        return str(reason) if reason else None
    return None


def is_retryable(status: int, reason: str | None) -> bool:
    if status == 429 or 500 <= status <= 599:
        return True
    return status == 403 and reason in _RATE_LIMIT_REASONS


def retry_delay(attempt: int, rand: float) -> float:
    """Seconds before retry ``attempt`` (0-based): exponential, jitter in [50%, 100%]."""
    base = min(_MAX_DELAY_S, _BASE_DELAY_S * float(1 << min(attempt, 16)))
    return base * (0.5 + 0.5 * rand)


def root_is_private(permissions: Iterable[Mapping[str, Any]], owner_email: str) -> bool:
    """True only when the root folder has exactly one permission: the owner's."""
    perms = list(permissions)
    if len(perms) != 1:
        return False
    p = perms[0]
    email = str(p.get("emailAddress") or "").lower()
    return p.get("type") == "user" and p.get("role") == "owner" and email == owner_email.lower()


class StreamSlots:
    """At most ``limit`` concurrent /media streams per process (a busy server answers 503)."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.in_use = 0

    def try_acquire(self) -> bool:
        if self.in_use >= self.limit:
            return False
        self.in_use += 1
        return True

    def release(self) -> None:
        self.in_use = max(0, self.in_use - 1)
