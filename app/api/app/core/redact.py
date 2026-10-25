"""Secret redaction for logs and Sentry (ARC-04). Pure.

Masks credentials in connection URLs, bearer tokens, Google/OpenAI-style API keys, and every
value stored under a key that looks secret (password, secret, token, key, authorization, ...).
"""

import re
from collections.abc import Mapping, Sequence
from typing import Any

REDACTED = "[REDACTED]"

_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # scheme://user:password@host → keep user and host
    (
        re.compile(r"(\b[a-z][a-z0-9+.-]*://[^\s:/@]+:)[^\s@/]+(@)", re.IGNORECASE),
        rf"\1{REDACTED}\2",
    ),
    (re.compile(r"(\bBearer\s+)[A-Za-z0-9._~+/=-]+", re.IGNORECASE), rf"\1{REDACTED}"),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{20,}"), REDACTED),  # Google API keys
    (re.compile(r"\bsk-[A-Za-z0-9_-]{12,}"), REDACTED),  # OpenAI-style keys
    (re.compile(r"\bxai-[A-Za-z0-9_-]{12,}"), REDACTED),  # xAI keys
    # key=value / key: value in free text (exception messages, driver errors)
    (
        re.compile(
            r"(\b(?:password|passwd|pwd|secret|token|api[_-]?key)\b\s*[=:]\s*)('[^']*'|\"[^\"]*\"|\S+)",
            re.IGNORECASE,
        ),
        rf"\1{REDACTED}",
    ),
]
_SECRET_KEY = re.compile(
    r"pass(word)?|secret|token|api[_-]?key|_key$|^key$|authorization|cookie|dsn", re.I
)


def _redact_str(text: str) -> str:
    for pattern, repl in _PATTERNS:
        text = pattern.sub(repl, text)
    return text


def redact(value: Any) -> Any:
    """A copy of ``value`` with secrets masked; recurses into mappings and sequences."""
    if isinstance(value, str):
        return _redact_str(value)
    if isinstance(value, Mapping):
        return {
            k: (REDACTED if isinstance(k, str) and _SECRET_KEY.search(k) else redact(v))
            for k, v in value.items()
        }
    if isinstance(value, Sequence) and not isinstance(value, bytes | bytearray):
        return [redact(v) for v in value]
    return value
