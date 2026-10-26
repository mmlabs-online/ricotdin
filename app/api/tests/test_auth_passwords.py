"""ARC-05: password hashing. argon2id for new hashes; bcrypt hashes migrated from Supabase verify
once and are flagged for rehash. Pure (CPU only)."""

import bcrypt
import pytest

from app.auth.passwords import hash_password, hash_scheme, verify_dummy, verify_password


def test_new_hashes_are_argon2id_and_verify() -> None:
    h = hash_password("correct horse")
    assert hash_scheme(h) == "argon2id"
    result = verify_password("correct horse", h)
    assert result.ok and not result.needs_rehash


def test_wrong_password_fails() -> None:
    assert not verify_password("nope", hash_password("correct horse")).ok


def test_each_hash_is_salted() -> None:
    assert hash_password("same") != hash_password("same")


def test_supabase_bcrypt_hash_verifies_and_needs_rehash() -> None:
    legacy = bcrypt.hashpw(b"from-supabase", bcrypt.gensalt(rounds=4)).decode()
    legacy = "$2a$" + legacy[4:]  # Supabase (GoTrue) writes the $2a$ prefix
    assert hash_scheme(legacy) == "bcrypt"
    result = verify_password("from-supabase", legacy)
    assert result.ok and result.needs_rehash
    assert not verify_password("wrong", legacy).ok


def test_bcrypt_ignores_nothing_beyond_72_bytes() -> None:
    # bcrypt silently truncates at 72 bytes; a longer password must not match its prefix.
    pw = "a" * 80
    legacy = bcrypt.hashpw(pw[:72].encode(), bcrypt.gensalt(rounds=4)).decode()
    assert not verify_password(pw, legacy).ok


@pytest.mark.parametrize("bad", ["", "plain", "$1$abc", "$argon2id$garbage"])
def test_unknown_or_corrupt_hashes_never_verify(bad: str) -> None:
    assert not verify_password("anything", bad).ok


def test_dummy_verify_runs_without_error() -> None:
    verify_dummy("whatever")  # equal work for unknown users (no user-enumeration by timing)
