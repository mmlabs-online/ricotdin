"""mmlabs per-app access tokens (AUT-05), issued by org-admin-api (``api.mmlabs.online``).

Contract: org-admin ``docs/consumers.md`` ("Verifying (backend) checklist"). Only ES256; keys
only from ``{issuer}/.well-known/jwks.json`` (never from token headers), chosen by ``kid``;
``iss`` exact;
``aud`` a string equal to ours; ``exp iat sub jti iss aud`` required; 30 s leeway; header
``typ == at+jwt``; ``email_verified is True``. Tokens are never logged.

The JWKS is cached for at most an hour; an unknown ``kid`` (key rotation) refetches it at most once
a minute. A failed refresh keeps the cached keys for at most a day after the last success (then
503); an empty JWKS answered by the issuer removes them.
"""

import asyncio
import json
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

import httpx2
import jwt as pyjwt
from cryptography.hazmat.primitives.asymmetric import ec

ALGORITHM = "ES256"
TOKEN_TYPE = "at+jwt"  # noqa: S105 - a JWT header value, not a secret
ADMIN_ROLE = "ricotdin:admin"
LEEWAY_S = 30
JWKS_MAX_AGE_S = 3600.0
JWKS_MIN_INTERVAL_S = 60.0
JWKS_HARD_MAX_AGE_S = 24 * 3600.0  # keys never outlive a day of failed refreshes
JWKS_MAX_BYTES = 64 * 1024
_REQUIRED = ["exp", "iat", "sub", "jti", "iss", "aud"]
_KEY_HINTS = ("jku", "x5u", "jwk", "x5c")

PublicKey = ec.EllipticCurvePublicKey
JwksFetcher = Callable[[], Awaitable[Any]]


class InvalidMmlabsToken(Exception):
    """The bearer token is not a valid mmlabs access token for this app (→ 401)."""


class MmlabsUnavailable(Exception):
    """No signing keys could be loaded from the mmlabs identity API (→ 503)."""


@dataclass(frozen=True)
class MmlabsClaims:
    sub: str
    email: str  # lower-cased when ASCII
    roles: tuple[str, ...]


def check_header(header: Mapping[str, Any]) -> str:
    """The ``kid`` of a header that may be verified; anything else is refused."""
    if header.get("alg") != ALGORITHM:
        raise InvalidMmlabsToken("alg")
    if header.get("typ") != TOKEN_TYPE:
        raise InvalidMmlabsToken("typ")
    if any(h in header for h in _KEY_HINTS):
        raise InvalidMmlabsToken("key location header")
    kid = header.get("kid")
    if not isinstance(kid, str) or not kid:
        raise InvalidMmlabsToken("kid")
    return kid


def is_mmlabs_token(token: str) -> bool:
    try:
        return pyjwt.get_unverified_header(token).get("alg") == ALGORITHM
    except pyjwt.PyJWTError:
        return False


def check_claims(payload: Mapping[str, Any], *, issuer: str, audience: str) -> MmlabsClaims:
    if payload.get("iss") != issuer:
        raise InvalidMmlabsToken("iss")
    if not isinstance(payload.get("aud"), str) or payload.get("aud") != audience:
        raise InvalidMmlabsToken("aud")
    if payload.get("email_verified") is not True:
        raise InvalidMmlabsToken("email_verified")
    sub, email, roles = payload.get("sub"), payload.get("email"), payload.get("roles")
    if not isinstance(sub, str) or not sub:
        raise InvalidMmlabsToken("sub")
    if not isinstance(email, str) or "@" not in email:
        raise InvalidMmlabsToken("email")
    if not isinstance(roles, list) or not all(isinstance(r, str) for r in roles):
        raise InvalidMmlabsToken("roles")
    # Only ASCII is case-folded: Unicode folding can turn one address into another (U+212A → "k"),
    # and a non-ASCII address is never linked by email (linking.py).
    return MmlabsClaims(sub, email.lower() if email.isascii() else email, tuple(roles))


def role_from_roles(roles: tuple[str, ...]) -> str:
    """ricotdin's own role (CLAUDE.md §0.1 R5 whitelist): admin only for ``ricotdin:admin``."""
    return "admin" if ADMIN_ROLE in roles else "user"


def keys_from_jwks(doc: Any) -> dict[str, PublicKey]:
    """P-256 signing keys by ``kid``; every other or malformed entry is skipped."""
    entries = doc.get("keys") if isinstance(doc, dict) else None
    keys: dict[str, PublicKey] = {}
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict) or not isinstance(entry.get("kid"), str):
            continue
        if entry.get("kty") != "EC" or entry.get("crv") != "P-256":
            continue
        if entry.get("use", "sig") != "sig" or entry.get("alg", ALGORITHM) != ALGORITHM:
            continue
        try:
            key = pyjwt.algorithms.ECAlgorithm.from_jwk(json.dumps(entry))
        except (pyjwt.PyJWTError, ValueError, TypeError, KeyError):
            continue
        if isinstance(key, ec.EllipticCurvePublicKey) and isinstance(key.curve, ec.SECP256R1):
            keys[entry["kid"]] = key
    return keys


def decode(token: str, key: PublicKey, *, issuer: str, audience: str) -> MmlabsClaims:
    try:
        payload = pyjwt.decode(
            token,
            key,
            algorithms=[ALGORITHM],
            audience=audience,
            issuer=issuer,
            leeway=LEEWAY_S,
            options={"require": _REQUIRED, "strict_aud": True},
        )
    except pyjwt.PyJWTError as exc:
        raise InvalidMmlabsToken(type(exc).__name__) from None
    return check_claims(payload, issuer=issuer, audience=audience)


class MmlabsVerifier:
    """Verifies tokens against the cached JWKS of ``issuer``."""

    def __init__(
        self,
        issuer: str,
        audience: str,
        fetch: JwksFetcher,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.issuer = issuer
        self.audience = audience
        self._fetch = fetch
        self._clock = clock
        self._keys: dict[str, PublicKey] = {}
        self._fetched_at: float | None = None  # last successful fetch
        self._tried_at: float | None = None  # last attempt
        self._lock = asyncio.Lock()

    def __repr__(self) -> str:
        return f"MmlabsVerifier(issuer={self.issuer!r}, audience={self.audience!r})"

    async def verify(self, token: str) -> MmlabsClaims:
        try:
            header = pyjwt.get_unverified_header(token)
        except pyjwt.PyJWTError as exc:
            raise InvalidMmlabsToken(type(exc).__name__) from None
        kid = check_header(header)
        key = await self._key(kid)
        return decode(token, key, issuer=self.issuer, audience=self.audience)

    async def _key(self, kid: str) -> PublicKey:
        now = self._clock()
        stale = self._fetched_at is None or now - self._fetched_at >= JWKS_MAX_AGE_S
        if stale or kid not in self._keys:
            async with self._lock:
                await self._refresh()
        if self._fetched_at is None or self._clock() - self._fetched_at >= JWKS_HARD_MAX_AGE_S:
            raise MmlabsUnavailable("no current mmlabs signing keys")
        key = self._keys.get(kid)
        if key is None:
            raise InvalidMmlabsToken("unknown kid")
        return key

    async def _refresh(self) -> None:
        now = self._clock()
        if self._tried_at is not None and now - self._tried_at < JWKS_MIN_INTERVAL_S:
            return  # at most one attempt a minute (unknown kids cannot force a fetch storm)
        self._tried_at = now
        try:
            doc = await self._fetch()
        except Exception:  # noqa: BLE001 - network or JSON trouble: keep what we have (for a while)
            return
        if not isinstance(doc, dict) or not isinstance(doc.get("keys"), list):
            return  # not a JWKS: treat like a failed fetch
        self._keys = keys_from_jwks(doc)  # an empty set means the issuer withdrew every key
        self._fetched_at = now


def http_jwks_fetcher(issuer: str, client: httpx2.AsyncClient) -> JwksFetcher:
    """GET ``{issuer}/.well-known/jwks.json`` (no redirects, bounded size, a User-Agent so
    Cloudflare does not block it)."""
    url = f"{issuer.rstrip('/')}/.well-known/jwks.json"

    async def fetch() -> Any:
        resp = await client.get(
            url,
            headers={"User-Agent": "ricotdin-api", "Accept": "application/json"},
            follow_redirects=False,
            timeout=10.0,
        )
        if resp.status_code != 200 or len(resp.content) > JWKS_MAX_BYTES:
            raise OSError(f"jwks HTTP {resp.status_code}")
        return resp.json()

    return fetch
