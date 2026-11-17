"""Test-only mmlabs tokens (AUT-05/06): one ES256 key, verified in-process (no network).

Test users are pre-linked with ``mmlabs_sub = 't-' || id`` (see ``link_sql``), so ``bearer(uid)``
maps straight to that user; ``role='admin'`` adds ``ricotdin:admin`` to the token roles."""

import json
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt as pyjwt
from cryptography.hazmat.primitives.asymmetric import ec

from app.auth.mmlabs import MmlabsVerifier

ISSUER = "https://mmlabs.test"
_KEY = ec.generate_private_key(ec.SECP256R1())
_JWK = {**json.loads(pyjwt.algorithms.ECAlgorithm.to_jwk(_KEY.public_key())), "kid": "t"}


async def _jwks() -> dict[str, Any]:
    return {"keys": [_JWK]}


def install(app: Any) -> None:
    """Make ``app`` trust the test issuer (call after ``create_app``)."""
    app.state.mmlabs = MmlabsVerifier(ISSUER, "ricotdin", _jwks)
    app.state.mmlabs_identities.clear()


def sub_for(uid: uuid.UUID) -> str:
    return f"t-{uid}"


def bearer(
    uid: uuid.UUID, role: str = "user", email: str | None = None, issued: datetime | None = None
) -> dict[str, str]:
    now = issued or datetime.now(UTC)
    roles = ["ricotdin:member"] + (["ricotdin:admin"] if role == "admin" else [])
    claims = {"iss": ISSUER, "aud": "ricotdin", "sub": sub_for(uid),
              "email": email or f"{uid}@example.test", "email_verified": True, "roles": roles,
              "iat": now, "exp": now + timedelta(minutes=15), "jti": secrets.token_hex(8)}  # fmt: skip
    tok = pyjwt.encode(claims, _KEY, algorithm="ES256", headers={"typ": "at+jwt", "kid": "t"})
    return {"Authorization": f"Bearer {tok}"}
