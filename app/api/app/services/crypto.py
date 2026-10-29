"""AES-256-GCM for stored secrets (ARC-06; port of v1 ``lib/crypto``). Pure. Server-only.

Same format as v1 so rows written by v1 decrypt here: random 12-byte IV, 16-byte tag, and three
base64 strings (``ciphertext``, ``iv``, ``authTag``) stored in separate columns. The master key is
``KEY_ENCRYPTION_SECRET`` (64 hex chars or standard base64 of 32 bytes; v1 also took base64url
via ``Buffer.from`` — the real secret is hex, verified against v1 data). Never log it or a
plaintext; losing it makes every stored provider key and the R2 secret unrecoverable.
"""

import base64
import binascii
import os
import re
from dataclasses import dataclass, field

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

KEY_BYTES = 32
IV_BYTES = 12
TAG_BYTES = 16
_HEX64 = re.compile(r"^[0-9a-fA-F]{64}$")


class DecryptError(Exception):
    """Ciphertext, IV, tag or key is wrong (tampered data or a different KEY_ENCRYPTION_SECRET)."""


@dataclass(frozen=True)
class EncryptedSecret:
    ciphertext: str = field(repr=False)
    iv: str = field(repr=False)
    auth_tag: str = field(repr=False)


def parse_master_key(raw: str) -> bytes:
    """32 bytes from 64 hex chars or base64 (v1 rule). The value is never echoed in errors."""
    text = raw.strip()
    if _HEX64.match(text):
        return bytes.fromhex(text)
    try:
        key = base64.b64decode(text, validate=True) if text else b""
    except (binascii.Error, ValueError):
        key = b""
    if len(key) != KEY_BYTES:
        raise ValueError("KEY_ENCRYPTION_SECRET must be 64 hex characters or base64 of 32 bytes")
    return key


def _check(key: bytes) -> None:
    if len(key) != KEY_BYTES:
        raise ValueError(f"encryption key must be {KEY_BYTES} bytes, got {len(key)}")


def encrypt_with_key(plaintext: str, key: bytes) -> EncryptedSecret:
    _check(key)
    iv = os.urandom(IV_BYTES)
    sealed = AESGCM(key).encrypt(iv, plaintext.encode("utf-8"), None)  # ciphertext || tag
    return EncryptedSecret(
        ciphertext=base64.b64encode(sealed[:-TAG_BYTES]).decode(),
        iv=base64.b64encode(iv).decode(),
        auth_tag=base64.b64encode(sealed[-TAG_BYTES:]).decode(),
    )


def decrypt_with_key(secret: EncryptedSecret, key: bytes) -> str:
    _check(key)
    try:
        ciphertext = base64.b64decode(secret.ciphertext, validate=True)
        iv = base64.b64decode(secret.iv, validate=True)
        tag = base64.b64decode(secret.auth_tag, validate=True)
    except (binascii.Error, ValueError):
        raise DecryptError("malformed base64") from None
    if len(iv) != IV_BYTES or len(tag) != TAG_BYTES:
        raise DecryptError("unexpected IV or tag length")
    try:
        plain = AESGCM(key).decrypt(iv, ciphertext + tag, None)
    except InvalidTag:
        raise DecryptError("authentication failed") from None
    try:
        return plain.decode("utf-8")
    except UnicodeDecodeError:
        raise DecryptError("plaintext is not UTF-8") from None
