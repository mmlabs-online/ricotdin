"""ARC-06: AES-256-GCM compatible with v1 (port of legacy/tests/provider-keys.test.ts + v1 fixture).

Pure. The fixture was produced by legacy/lib/crypto `encryptSecretWithKey` (Node) with a TEST key.
"""

import base64
import json
from pathlib import Path

import pytest

from app.services.crypto import (
    DecryptError,
    EncryptedSecret,
    decrypt_with_key,
    encrypt_with_key,
    parse_master_key,
)

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "v1" / "crypto_v1.json").read_text("utf-8")
)
V1_KEY = bytes.fromhex(FIXTURE["key_hex"])
KEY = bytes(range(32))
OTHER = bytes(32)


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: repr(c["plaintext"])[:20])
def test_v1_ciphertext_decrypts_in_v2(case: dict[str, str]) -> None:
    secret = EncryptedSecret(case["ciphertext"], case["iv"], case["authTag"])
    assert decrypt_with_key(secret, V1_KEY) == case["plaintext"]


def test_v2_output_has_the_v1_shape() -> None:
    s = encrypt_with_key("AIza-example", KEY)
    assert len(base64.b64decode(s.iv)) == 12
    assert len(base64.b64decode(s.auth_tag)) == 16
    assert len(base64.b64decode(s.ciphertext)) == len("AIza-example")


def test_round_trip_unicode() -> None:
    assert decrypt_with_key(encrypt_with_key("khoá 🙂", KEY), KEY) == "khoá 🙂"


def test_random_iv_each_call() -> None:
    a, b = encrypt_with_key("same", KEY), encrypt_with_key("same", KEY)
    assert a.iv != b.iv and a.ciphertext != b.ciphertext


def _flip(b64: str) -> str:
    raw = bytearray(base64.b64decode(b64))
    raw[0] ^= 0x01
    return base64.b64encode(bytes(raw)).decode()


def test_tampered_ciphertext_raises() -> None:
    s = encrypt_with_key("secret-value", KEY)
    with pytest.raises(DecryptError):
        decrypt_with_key(EncryptedSecret(_flip(s.ciphertext), s.iv, s.auth_tag), KEY)


def test_tampered_tag_raises() -> None:
    s = encrypt_with_key("secret-value", KEY)
    with pytest.raises(DecryptError):
        decrypt_with_key(EncryptedSecret(s.ciphertext, s.iv, _flip(s.auth_tag)), KEY)


def test_tampered_iv_raises() -> None:
    s = encrypt_with_key("secret-value", KEY)
    with pytest.raises(DecryptError):
        decrypt_with_key(EncryptedSecret(s.ciphertext, _flip(s.iv), s.auth_tag), KEY)


def test_wrong_key_raises() -> None:
    with pytest.raises(DecryptError):
        decrypt_with_key(encrypt_with_key("secret-value", KEY), OTHER)


@pytest.mark.parametrize("bad", ["", "!!!", "AAAA"])
def test_malformed_base64_raises(bad: str) -> None:
    s = encrypt_with_key("x", KEY)
    with pytest.raises(DecryptError):
        decrypt_with_key(EncryptedSecret(bad, s.iv, s.auth_tag), KEY)


@pytest.mark.parametrize("length", [0, 16, 31, 33])
def test_key_must_be_32_bytes(length: int) -> None:
    with pytest.raises(ValueError, match="32 bytes"):
        encrypt_with_key("x", bytes(length))
    with pytest.raises(ValueError, match="32 bytes"):
        decrypt_with_key(EncryptedSecret("", "", ""), bytes(length))


def test_master_key_accepts_hex_and_base64_like_v1() -> None:
    assert parse_master_key(KEY.hex()) == KEY
    assert parse_master_key(KEY.hex().upper()) == KEY
    assert parse_master_key(base64.b64encode(KEY).decode()) == KEY
    assert parse_master_key(f"  {KEY.hex()}\n") == KEY


@pytest.mark.parametrize("bad", ["", "abc", "zz" * 32, base64.b64encode(bytes(16)).decode()])
def test_master_key_rejects_anything_else_without_echoing_it(bad: str) -> None:
    with pytest.raises(ValueError, match="KEY_ENCRYPTION_SECRET") as exc:
        parse_master_key(bad)
    if bad:
        assert bad not in str(exc.value)


def test_secret_repr_hides_ciphertext() -> None:
    s = encrypt_with_key("x", KEY)
    assert s.ciphertext not in repr(s)
