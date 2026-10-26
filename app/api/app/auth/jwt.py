"""EdDSA (Ed25519) access tokens and the JWKS document (ARC-05). Pure.

Claims: ``sub`` (user id), ``role`` (``user|admin``, read from ``users.role`` when issued),
``typ=access``, ``iss``, ``aud``, ``iat``, ``exp`` (15 minutes). Only EdDSA is accepted on
verify, so ``alg: none`` / HS256-with-the-public-key forgeries fail.
"""

import base64
import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt as pyjwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

ISSUER = "ricotdin-api"
AUDIENCE = "ricotdin-web"
ACCESS_TTL = timedelta(minutes=15)
_ROLES = {"user", "admin"}


class InvalidAccessToken(Exception):
    """The bearer token is missing, malformed, expired, forged or has unexpected claims."""


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def generate_private_pem() -> str:
    return (
        Ed25519PrivateKey.generate()
        .private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        .decode()
    )


@dataclass(frozen=True)
class JwtKeys:
    private_key: Ed25519PrivateKey
    public_key: Ed25519PublicKey
    public_raw: bytes
    kid: str

    def __repr__(self) -> str:
        return f"JwtKeys(kid={self.kid!r})"

    @classmethod
    def from_private_pem(cls, pem: str) -> "JwtKeys":
        text = pem.strip().replace("\\n", "\n")  # single-line env values
        key = serialization.load_pem_private_key(text.encode(), password=None)
        if not isinstance(key, Ed25519PrivateKey):
            raise ValueError("JWT_PRIVATE_KEY must be an Ed25519 private key (PEM, PKCS#8)")
        public = key.public_key()
        raw = public.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        # RFC 7638 thumbprint of the OKP JWK
        canonical = json.dumps(
            {"crv": "Ed25519", "kty": "OKP", "x": _b64url(raw)}, separators=(",", ":")
        )
        kid = _b64url(hashlib.sha256(canonical.encode()).digest())
        return cls(key, public, raw, kid)

    @property
    def public_pem(self) -> bytes:
        return self.public_key.public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
        )

    def jwks(self) -> dict[str, Any]:
        return {
            "keys": [
                {
                    "kty": "OKP",
                    "crv": "Ed25519",
                    "x": _b64url(self.public_raw),
                    "kid": self.kid,
                    "alg": "EdDSA",
                    "use": "sig",
                }
            ]
        }


@dataclass(frozen=True)
class AccessClaims:
    user_id: uuid.UUID
    role: str


def issue_access_token(
    keys: JwtKeys, user_id: uuid.UUID, role: str, now: datetime | None = None
) -> str:
    if role not in _ROLES:
        raise ValueError("role must be 'user' or 'admin'")
    issued = now or datetime.now(UTC)
    payload = {
        "sub": str(user_id),
        "role": role,
        "typ": "access",
        "iss": ISSUER,
        "aud": AUDIENCE,
        "iat": issued,
        "exp": issued + ACCESS_TTL,
    }
    return pyjwt.encode(payload, keys.private_key, algorithm="EdDSA", headers={"kid": keys.kid})


def verify_access_token(keys: JwtKeys, token: str) -> AccessClaims:
    try:
        payload = pyjwt.decode(
            token,
            keys.public_key,
            algorithms=["EdDSA"],
            audience=AUDIENCE,
            issuer=ISSUER,
            options={"require": ["sub", "role", "typ", "iss", "aud", "iat", "exp"]},
            leeway=10,
        )
    except pyjwt.PyJWTError as exc:
        raise InvalidAccessToken(type(exc).__name__) from None
    if payload.get("typ") != "access" or payload.get("role") not in _ROLES:
        raise InvalidAccessToken("unexpected claims")
    try:
        user_id = uuid.UUID(str(payload["sub"]))
    except ValueError:
        raise InvalidAccessToken("sub is not a uuid") from None
    return AccessClaims(user_id, payload["role"])
