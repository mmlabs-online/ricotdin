"""Password hashing (ARC-05). argon2id for every new hash; bcrypt only to verify hashes migrated
from Supabase (GoTrue ``$2a$``), which are then rehashed on the next successful login.

CPU-bound: call from a worker thread in async code (``anyio.to_thread.run_sync``).
"""

from dataclasses import dataclass
from typing import Literal

import bcrypt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

_hasher = PasswordHasher()  # argon2id, library defaults (RFC 9106 low-memory profile)
_DUMMY_HASH = _hasher.hash("ricotdin-dummy-password")

Scheme = Literal["argon2id", "bcrypt", "unknown"]


@dataclass(frozen=True)
class VerifyResult:
    ok: bool
    needs_rehash: bool = False


def hash_scheme(stored: str) -> Scheme:
    if stored.startswith("$argon2id$"):
        return "argon2id"
    if stored.startswith(("$2a$", "$2b$", "$2y$")):
        return "bcrypt"
    return "unknown"


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, stored: str) -> VerifyResult:
    scheme = hash_scheme(stored)
    if scheme == "argon2id":
        try:
            _hasher.verify(stored, password)
        except (VerifyMismatchError, VerificationError, InvalidHashError):
            return VerifyResult(False)
        return VerifyResult(True, needs_rehash=_hasher.check_needs_rehash(stored))
    if scheme == "bcrypt":
        raw = password.encode()
        if len(raw) > 72:  # bcrypt would silently compare only the first 72 bytes
            return VerifyResult(False)
        try:
            ok = bcrypt.checkpw(raw, stored.encode())
        except ValueError:
            return VerifyResult(False)
        return VerifyResult(ok, needs_rehash=ok)
    return VerifyResult(False)


def verify_dummy(password: str) -> None:
    """Same work as a real verify, for identifiers that match no user (no timing oracle)."""
    try:
        _hasher.verify(_DUMMY_HASH, password)
    except VerificationError:
        pass
