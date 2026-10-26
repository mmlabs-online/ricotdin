"""ARC-05: EdDSA access tokens + JWKS. Pure (key generated in-process)."""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app.auth.jwt import (
    InvalidAccessToken,
    JwtKeys,
    generate_private_pem,
    issue_access_token,
    verify_access_token,
)

USER = uuid.uuid4()


@pytest.fixture(scope="module")
def keys() -> JwtKeys:
    return JwtKeys.from_private_pem(generate_private_pem())


def test_round_trip(keys: JwtKeys) -> None:
    token = issue_access_token(keys, USER, "admin", now=datetime.now(UTC))
    claims = verify_access_token(keys, token)
    assert claims.user_id == USER and claims.role == "admin"


def test_header_names_alg_and_kid(keys: JwtKeys) -> None:
    header = pyjwt.get_unverified_header(issue_access_token(keys, USER, "user"))
    assert header["alg"] == "EdDSA" and header["kid"] == keys.kid


def test_lifetime_is_fifteen_minutes(keys: JwtKeys) -> None:
    now = datetime(2030, 1, 1, tzinfo=UTC)
    payload = pyjwt.decode(
        issue_access_token(keys, USER, "user", now=now), options={"verify_signature": False}
    )
    assert payload["exp"] - payload["iat"] == 15 * 60
    assert payload["typ"] == "access" and payload["sub"] == str(USER)


def test_expired_token_is_rejected(keys: JwtKeys) -> None:
    old = datetime.now(UTC) - timedelta(hours=1)
    with pytest.raises(InvalidAccessToken):
        verify_access_token(keys, issue_access_token(keys, USER, "user", now=old))


def test_token_from_another_key_is_rejected(keys: JwtKeys) -> None:
    other = JwtKeys.from_private_pem(generate_private_pem())
    with pytest.raises(InvalidAccessToken):
        verify_access_token(keys, issue_access_token(other, USER, "user"))


@pytest.mark.parametrize("alg_attack", ["none", "HS256"])
def test_algorithm_confusion_is_rejected(keys: JwtKeys, alg_attack: str) -> None:
    now = datetime.now(UTC)
    exp = now + timedelta(minutes=5)
    payload: dict[str, Any] = {
        "sub": str(USER), "role": "admin", "typ": "access", "iss": "ricotdin-api",
        "aud": "ricotdin-web", "iat": now, "exp": exp,
    }  # fmt: skip
    if alg_attack == "none":
        forged = pyjwt.encode(payload, key="", algorithm="none")
    else:  # HMAC keyed with the public key (classic confusion); PyJWT refuses to build it
        import base64
        import hashlib
        import hmac
        import json

        def b64(raw: bytes) -> str:
            return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

        claims = {
            **payload,
            "iat": int(now.timestamp()),
            "exp": int(exp.timestamp()),
        }
        signing = (
            b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
            + "."
            + b64(json.dumps(claims).encode())
        )
        sig = hmac.new(keys.public_pem, signing.encode(), hashlib.sha256).digest()
        forged = signing + "." + b64(sig)
    with pytest.raises(InvalidAccessToken):
        verify_access_token(keys, forged)


@pytest.mark.parametrize(
    "override",
    [{"role": "superuser"}, {"typ": "refresh"}, {"aud": "other"}, {"iss": "other"}, {"sub": "x"}],
)
def test_wrong_claims_are_rejected(keys: JwtKeys, override: dict[str, str]) -> None:
    now = datetime.now(UTC)
    payload = {
        "sub": str(USER), "role": "user", "typ": "access", "iss": "ricotdin-api",
        "aud": "ricotdin-web", "iat": now, "exp": now + timedelta(minutes=5), **override,
    }  # fmt: skip
    forged = pyjwt.encode(payload, keys.private_key, algorithm="EdDSA", headers={"kid": keys.kid})
    with pytest.raises(InvalidAccessToken):
        verify_access_token(keys, forged)


def test_garbage_is_rejected(keys: JwtKeys) -> None:
    with pytest.raises(InvalidAccessToken):
        verify_access_token(keys, "not.a.jwt")


def test_jwks_publishes_only_the_public_key(keys: JwtKeys) -> None:
    jwks = keys.jwks()
    (jwk,) = jwks["keys"]
    assert jwk["kty"] == "OKP" and jwk["crv"] == "Ed25519" and jwk["kid"] == keys.kid
    assert jwk["alg"] == "EdDSA" and jwk["use"] == "sig"
    assert "d" not in jwk  # private part never published


def test_non_ed25519_keys_are_refused() -> None:
    from cryptography.hazmat.primitives.asymmetric import rsa

    pem = (
        rsa.generate_private_key(public_exponent=65537, key_size=2048)
        .private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        .decode()
    )
    with pytest.raises(ValueError, match="Ed25519"):
        JwtKeys.from_private_pem(pem)


def test_pem_with_escaped_newlines_from_env_files_is_accepted() -> None:
    pem = generate_private_pem()
    assert JwtKeys.from_private_pem(pem.replace("\n", "\\n")).kid


def test_kid_is_stable_for_a_key() -> None:
    pem = (
        Ed25519PrivateKey.generate()
        .private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        .decode()
    )
    assert JwtKeys.from_private_pem(pem).kid == JwtKeys.from_private_pem(pem).kid


def test_previous_key_still_verifies_during_rotation_and_is_published() -> None:
    old = JwtKeys.from_private_pem(generate_private_pem())
    token = issue_access_token(old, USER, "user")
    new = JwtKeys.from_private_pem(generate_private_pem()).with_previous(old.public_pem.decode())
    assert verify_access_token(new, token).user_id == USER
    kids = [k["kid"] for k in new.jwks()["keys"]]
    assert kids == [new.kid, old.kid]
    assert (
        issue_access_token(new, USER, "user")
        and pyjwt.get_unverified_header(issue_access_token(new, USER, "user"))["kid"] == new.kid
    )  # always signs with the current key


def test_unknown_kid_is_rejected(keys: JwtKeys) -> None:
    other = JwtKeys.from_private_pem(generate_private_pem())
    with pytest.raises(InvalidAccessToken):
        verify_access_token(keys, issue_access_token(other, USER, "user"))


def test_previous_key_must_be_an_ed25519_public_key(keys: JwtKeys) -> None:
    with pytest.raises(ValueError, match="Ed25519"):
        keys.with_previous("not a pem")
