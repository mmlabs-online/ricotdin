"""AUT-05: verifying mmlabs per-app access tokens (org-admin docs/consumers.md checklist).

Pure checks plus ``MmlabsVerifier`` with an in-memory JWKS fetcher and a fake clock (no network).
"""

import asyncio
import base64
import hashlib
import hmac
import json
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app.auth.mmlabs import (
    ADMIN_ROLE,
    InvalidMmlabsToken,
    MmlabsClaims,
    MmlabsUnavailable,
    MmlabsVerifier,
    check_claims,
    check_header,
    is_mmlabs_token,
    keys_from_jwks,
    role_from_roles,
)

ISS = "https://api.mmlabs.online"
AUD = "ricotdin"
SUB = "0b8f2c1e-1111-4222-8333-444455556666"


def new_key() -> ec.EllipticCurvePrivateKey:
    return ec.generate_private_key(ec.SECP256R1())


def jwk(key: ec.EllipticCurvePrivateKey, kid: str) -> dict[str, Any]:
    pub = json.loads(pyjwt.algorithms.ECAlgorithm.to_jwk(key.public_key()))
    return {**pub, "kid": kid, "alg": "ES256", "use": "sig"}


KEY = new_key()
JWKS = {"keys": [jwk(KEY, "k1")]}


def claims(**over: Any) -> dict[str, Any]:
    now = datetime.now(UTC)
    base: dict[str, Any] = {
        "iss": ISS,
        "aud": AUD,
        "sub": SUB,
        "email": "Owner@Example.com",
        "email_verified": True,
        "roles": ["ricotdin:member"],
        "iat": now,
        "exp": now + timedelta(minutes=15),
        "jti": "jti-1",
    }
    base.update(over)
    return {k: v for k, v in base.items() if v is not ...}


def token(
    payload: dict[str, Any] | None = None,
    *,
    key: Any = KEY,
    alg: str = "ES256",
    headers: dict[str, Any] | None = None,
) -> str:
    h = {"typ": "at+jwt", "kid": "k1", **(headers or {})}
    return pyjwt.encode(payload or claims(), key, algorithm=alg, headers=h)


class Fetcher:
    def __init__(self, *docs: Any) -> None:
        self.docs = list(docs)
        self.calls = 0

    async def __call__(self) -> dict[str, Any]:
        self.calls += 1
        doc = self.docs.pop(0) if len(self.docs) > 1 else self.docs[0]
        if isinstance(doc, Exception):
            raise doc
        return dict(doc)


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def verifier(fetch: Fetcher, clock: Clock | None = None) -> MmlabsVerifier:
    return MmlabsVerifier(ISS, AUD, fetch, clock=clock or Clock())


def verify(v: MmlabsVerifier, tok: str) -> MmlabsClaims:
    return asyncio.run(v.verify(tok))


# --- pure checks --------------------------------------------------------------------------------


def test_header_needs_es256_typ_and_kid() -> None:
    assert check_header({"alg": "ES256", "typ": "at+jwt", "kid": "k1"}) == "k1"
    for bad in (
        {"alg": "EdDSA", "typ": "at+jwt", "kid": "k1"},
        {"alg": "none", "typ": "at+jwt", "kid": "k1"},
        {"alg": "HS256", "typ": "at+jwt", "kid": "k1"},
        {"alg": "ES256", "typ": "JWT", "kid": "k1"},
        {"alg": "ES256", "kid": "k1"},
        {"alg": "ES256", "typ": "at+jwt"},
        {"alg": "ES256", "typ": "at+jwt", "kid": 7},
    ):
        with pytest.raises(InvalidMmlabsToken):
            check_header(bad)


def test_header_refuses_key_location_hints() -> None:
    for hint in ("jku", "x5u", "jwk", "x5c"):
        with pytest.raises(InvalidMmlabsToken):
            check_header({"alg": "ES256", "typ": "at+jwt", "kid": "k1", hint: "x"})


def test_is_mmlabs_token_reads_only_the_header_alg() -> None:
    assert is_mmlabs_token(token())
    ed = Ed25519PrivateKey.generate()
    assert not is_mmlabs_token(pyjwt.encode({"sub": "x"}, ed, algorithm="EdDSA"))
    assert not is_mmlabs_token("not-a-jwt")


def test_check_claims_returns_sub_email_roles() -> None:
    c = check_claims(
        {"iss": ISS, "aud": AUD, "sub": SUB, "email": "A@x.com", "email_verified": True,
         "roles": ["ricotdin:admin", "ricotdin:member"], "jti": "j"},
        issuer=ISS, audience=AUD,
    )  # fmt: skip
    assert c == MmlabsClaims(SUB, "a@x.com", ("ricotdin:admin", "ricotdin:member"))


@pytest.mark.parametrize(
    "over",
    [
        {"iss": "https://api.mmlabs.online.evil"},
        {"aud": ["ricotdin"]},  # a list is refused (strict_aud)
        {"aud": "admin"},
        {"email_verified": False},
        {"email_verified": "true"},
        {"sub": ""},
        {"email": None},
        {"roles": "ricotdin:admin"},
        {"roles": ["ricotdin:admin", 3]},
    ],
)
def test_check_claims_rejects(over: dict[str, Any]) -> None:
    base = {"iss": ISS, "aud": AUD, "sub": SUB, "email": "a@x.com", "email_verified": True,
            "roles": [], "jti": "j"}  # fmt: skip
    with pytest.raises(InvalidMmlabsToken):
        check_claims({**base, **over}, issuer=ISS, audience=AUD)


def test_role_from_roles() -> None:
    assert ADMIN_ROLE == "ricotdin:admin"
    assert role_from_roles(("ricotdin:member", "ricotdin:admin")) == "admin"
    assert role_from_roles(("ricotdin:member",)) == "user"
    assert role_from_roles(()) == "user"
    assert role_from_roles(("admin:super-admin",)) == "user"  # another app's role is not ours


def test_keys_from_jwks_keeps_only_p256_signing_keys() -> None:
    other = new_key()
    doc = {
        "keys": [
            jwk(KEY, "k1"),
            {**jwk(other, "enc"), "use": "enc"},
            {**jwk(other, "rs"), "alg": "RS256"},
            {"kty": "OKP", "crv": "Ed25519", "x": "AAAA", "kid": "ed"},
            {"kty": "EC", "crv": "P-256", "kid": "broken", "x": "!", "y": "!"},
            "junk",
        ]
    }
    assert set(keys_from_jwks(doc)) == {"k1"}
    assert keys_from_jwks({"nope": 1}) == {}
    assert keys_from_jwks("junk") == {}


# --- MmlabsVerifier -----------------------------------------------------------------------------


def test_a_valid_token_verifies() -> None:
    c = verify(verifier(Fetcher(JWKS)), token())
    assert c.sub == SUB and c.email == "owner@example.com" and c.roles == ("ricotdin:member",)


@pytest.mark.parametrize(
    ("payload", "headers"),
    [
        (claims(aud="admin"), None),
        (claims(iss="https://evil.example"), None),
        (claims(exp=datetime.now(UTC) - timedelta(minutes=5)), None),  # beyond the 30 s leeway
        (claims(email_verified=False), None),
        (claims(jti=...), None),
        (claims(iat=...), None),
        (claims(), {"typ": "JWT"}),
        (claims(), {"kid": "unknown"}),
    ],
)
def test_bad_tokens_are_rejected(payload: dict[str, Any], headers: dict[str, Any] | None) -> None:
    with pytest.raises(InvalidMmlabsToken):
        verify(verifier(Fetcher(JWKS)), token(payload, headers=headers))


def test_a_token_signed_by_another_key_with_our_kid_is_rejected() -> None:
    with pytest.raises(InvalidMmlabsToken):
        verify(verifier(Fetcher(JWKS)), token(key=new_key()))


def test_an_hs256_token_using_the_public_jwk_is_rejected() -> None:
    # PyJWT refuses to sign with a JWK as an HMAC secret, so build the forgery by hand
    def b64(raw: bytes) -> str:
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    payload = {**claims(), "iat": 0, "exp": 2**31 - 1}
    head = b64(json.dumps({"alg": "HS256", "typ": "at+jwt", "kid": "k1"}).encode())
    body = b64(json.dumps(payload).encode())
    secret = json.dumps(JWKS["keys"][0]).encode()
    sig = b64(hmac.new(secret, f"{head}.{body}".encode(), hashlib.sha256).digest())
    forged = f"{head}.{body}.{sig}"
    with pytest.raises(InvalidMmlabsToken):
        verify(verifier(Fetcher(JWKS)), forged)


def test_jwks_is_cached_and_refetched_after_an_hour() -> None:
    fetch, clock = Fetcher(JWKS), Clock()
    v = verifier(fetch, clock)
    verify(v, token())
    verify(v, token())
    assert fetch.calls == 1
    clock.t += 3601
    verify(v, token())
    assert fetch.calls == 2


def test_an_unknown_kid_refetches_at_most_once_a_minute() -> None:
    new = new_key()
    rotated = {"keys": [jwk(KEY, "k1"), jwk(new, "k2")]}
    fetch, clock = Fetcher(JWKS, rotated), Clock()
    v = verifier(fetch, clock)
    verify(v, token())  # first fetch
    clock.t += 5  # within the minute after the first fetch: no refetch yet
    with pytest.raises(InvalidMmlabsToken):
        verify(v, token(key=new, headers={"kid": "k2"}))
    assert fetch.calls == 1
    clock.t += 60
    assert verify(v, token(key=new, headers={"kid": "k2"})).sub == SUB  # refetched, rotated key
    assert fetch.calls == 2
    with pytest.raises(InvalidMmlabsToken):
        verify(v, token(headers={"kid": "k3"}))  # unknown again, too soon: no third fetch
    assert fetch.calls == 2


def test_jwks_unreachable_at_start_is_unavailable_not_invalid() -> None:
    v = verifier(Fetcher(OSError("down")))
    with pytest.raises(MmlabsUnavailable):
        verify(v, token())


def test_a_failed_refresh_keeps_the_cached_keys() -> None:
    fetch, clock = Fetcher(JWKS, OSError("down")), Clock()
    v = verifier(fetch, clock)
    verify(v, token())
    clock.t += 3601  # stale: refresh fails, the cached key still verifies
    assert verify(v, token()).sub == SUB
