"""Secret redaction for logs and Sentry (ARC-04). Pure.

Masks credentials in URLs (user:password@, DSN keys), Bearer/Basic auth, JWTs, Google/OpenAI/
xAI-style API keys, ``key=value`` / ``"key": value`` pairs with secret-looking keys, and every
mapping value stored under a secret-looking key. Counts such as ``input_tokens`` or ids such as
``dedup_key`` are not secrets and stay readable (usage logs, §9e).
"""

import re
from collections.abc import Mapping, Sequence, Set
from typing import Any

REDACTED = "[REDACTED]"
_MAX_DEPTH = 20

_KEY = (
    r"(?:[A-Za-z0-9_]*(?:password(?:_hash)?|passwd|pwd|secret|token|api_?key|private_?key|dsn)"
    r"|input_value)"
)
_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # PEM private keys, with real or escaped (\n) newlines; first, so the key=value rule below
    # cannot stop at the first space inside the block
    (
        re.compile(
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.DOTALL
        ),
        REDACTED,
    ),
    # scheme://user:password@host → keep user and host
    (
        re.compile(r"(\b[a-z][a-z0-9+.-]*://[^\s:/@]+:)[^\s@/]+(@)", re.IGNORECASE),
        rf"\1{REDACTED}\2",
    ),
    # scheme://<key>@host (Sentry-style DSN keys)
    (re.compile(r"(\b[a-z][a-z0-9+.-]*://)[A-Za-z0-9]{16,}(@)", re.IGNORECASE), rf"\1{REDACTED}\2"),
    (
        re.compile(r"(\b(?:Bearer|Basic|Token)\s+)[A-Za-z0-9._~+/=-]+", re.IGNORECASE),
        rf"\1{REDACTED}",
    ),
    # cookie / set-cookie headers in free text: everything up to the end of the line
    (
        re.compile(r"(\b(?:set-)?cookie\s*:\s*)(?!\[REDACTED\])[^\r\n]+", re.IGNORECASE),
        rf"\1{REDACTED}",
    ),
    (re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"), REDACTED),  # JWT
    (re.compile(r"\bAIza[0-9A-Za-z_-]{20,}"), REDACTED),  # Google API keys
    (re.compile(r"\bsk-[A-Za-z0-9_-]{12,}"), REDACTED),  # OpenAI-style keys
    (re.compile(r"\bxai-[A-Za-z0-9_-]{12,}"), REDACTED),  # xAI keys
    # key=value, key: value, 'key': 'value', "key": "value", key%3Dvalue in free text / reprs.
    # (?!\[REDACTED\]) keeps redaction idempotent (text is redacted again by the formatter).
    (
        re.compile(
            rf"((?<![A-Za-z0-9_]){_KEY}(?:['\"]?\s*[=:]\s*|%3D))(?!\[REDACTED\])"
            r"('[^']*'|\"[^\"]*\"|[^\s,}\]&]+)",
            re.IGNORECASE,
        ),
        rf"\1{REDACTED}",
    ),
]

_ALWAYS_SECRET_PARTS = {"password", "passwd", "pwd", "secret", "cookie", "authorization", "dsn"}
_KEY_QUALIFIERS = {"api", "private", "access", "secret", "encryption", "service", "role", "signing"}


def is_secret_key(key: str) -> bool:
    """Whether a mapping key names a secret (``refresh_token``, ``apiKey``, ``..._ROLE_KEY``)."""
    snake = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", key).lower()
    parts = [p for p in re.split(r"[_\-\s]+", snake) if p]
    if not parts:
        return False
    if _ALWAYS_SECRET_PARTS & set(parts):
        return True
    if parts[-1] == "token":
        return True
    if parts[-1] == "key":
        return len(parts) == 1 or parts[-2] in _KEY_QUALIFIERS
    return parts == ["apikey"]


def _redact_str(text: str) -> str:
    for pattern, repl in _PATTERNS:
        text = pattern.sub(repl, text)
    return text


def redact(value: Any, _seen: frozenset[int] = frozenset(), _depth: int = 0) -> Any:
    """A copy of ``value`` with secrets masked; recurses into mappings, sequences and sets."""
    if isinstance(value, str):
        return _redact_str(value)
    if isinstance(value, bytes | bytearray):
        return value
    if isinstance(value, Mapping | Sequence | Set):
        if id(value) in _seen or _depth >= _MAX_DEPTH:
            return "[CYCLE]"
        seen = _seen | {id(value)}
        if isinstance(value, Mapping):
            return {
                k: (
                    REDACTED
                    if isinstance(k, str) and is_secret_key(k)
                    else redact(v, seen, _depth + 1)
                )
                for k, v in value.items()
            }
        return [redact(v, seen, _depth + 1) for v in value]
    return value
