"""Signed playback tokens for ``GET /media`` (ARC-17). Pure.

Drive has no signed URLs, so the API proxies playback. A token is
``<expiry>.<base64url(key)>.<base64url(hmac)>`` with HMAC-SHA256 over ``expiry \\n key``. The
HMAC key is derived from KEY_ENCRYPTION_SECRET with HKDF (no new env var); rotating that secret
invalidates outstanding tokens, which live at most 15 minutes anyway. A token is a bearer
capability for one file: it travels in the query string, which our access logs drop.
"""

import base64
import binascii
import hashlib
import hmac
import re

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

MAX_MEDIA_TTL_S = 900
DEFAULT_MEDIA_TTL_S = 900
_MAX_TOKEN_LEN = 1024
_EXPIRY = re.compile(r"[1-9][0-9]{0,11}")
_B64 = re.compile(r"[A-Za-z0-9_-]+")
_INFO = b"ricotdin media token v1"


def derive_media_key(master_key: bytes) -> bytes:
    if len(master_key) != 32:
        raise ValueError("master key must be 32 bytes")
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=_INFO).derive(master_key)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    if not _B64.fullmatch(text):
        raise ValueError("not base64url")
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class MediaTokenSigner:
    def __init__(self, key: bytes) -> None:
        self._key = key

    def __repr__(self) -> str:
        return "MediaTokenSigner()"

    def _mac(self, expiry: int, key: str) -> bytes:
        return hmac.new(self._key, f"{expiry}\n{key}".encode(), hashlib.sha256).digest()

    def sign(self, key: str, *, now: float, ttl: int = DEFAULT_MEDIA_TTL_S) -> str:
        if not 1 <= ttl <= MAX_MEDIA_TTL_S:
            raise ValueError(f"ttl must be 1..{MAX_MEDIA_TTL_S} seconds")
        expiry = int(now) + ttl
        return f"{expiry}.{_b64(key.encode())}.{_b64(self._mac(expiry, key))}"

    def verify(self, token: str, *, now: float) -> str | None:
        """The key the token grants, or None (malformed, tampered, expired or too far ahead)."""
        if not token or len(token) > _MAX_TOKEN_LEN:
            return None
        parts = token.split(".")
        if len(parts) != 3 or not _EXPIRY.fullmatch(parts[0]):
            return None
        try:
            key = _unb64(parts[1]).decode("utf-8")
            mac = _unb64(parts[2])
        except (ValueError, binascii.Error, UnicodeDecodeError):
            return None
        expiry = int(parts[0])
        if not hmac.compare_digest(mac, self._mac(expiry, key)):
            return None
        if not now < expiry <= now + MAX_MEDIA_TTL_S:
            return None
        return key
