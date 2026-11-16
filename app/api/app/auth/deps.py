"""FastAPI dependencies for authenticated routes (ARC-05, AUT-05).

``current_identity`` turns a verified bearer access token into the ``RequestIdentity`` used by
``db.app_transaction`` (CLAUDE.md §0.1 R5: values only from the verified token).

- An **mmlabs** token (ES256, AUT-05) is verified against the mmlabs JWKS; its ``sub`` is mapped
  to the ricotdin user (``users.mmlabs_sub``, linked or created on first use) and the role comes
  from its ``roles`` (``ricotdin:admin`` → ``admin``). Role and disable changes made in mmlabs apply
  within the token lifetime (15 min); a ricotdin-disabled user is refused at once.
- A **legacy ricotdin** token (EdDSA, ARC-05) is still accepted until AUT-06 removes it (the two
  ship in one release, so production only sees mmlabs tokens).
"""

import ipaddress
from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.auth.jwt import InvalidAccessToken, JwtKeys, verify_access_token
from app.auth.linking import resolve_user
from app.auth.mmlabs import (
    InvalidMmlabsToken,
    MmlabsUnavailable,
    MmlabsVerifier,
    is_mmlabs_token,
    role_from_roles,
)
from app.auth.runtime import AuthRuntime
from app.core.errors import Forbidden, ServiceUnavailable, Unauthorized
from app.db.context import RequestIdentity
from app.db.session import Database, get_database

SERVICE = "ricotdin_service"

_bearer = HTTPBearer(auto_error=False, description="mmlabs access token (POST /api/v1/auth/token)")


def auth_runtime(request: Request) -> AuthRuntime:
    runtime: AuthRuntime = request.app.state.auth
    return runtime


def signing_keys(runtime: Annotated[AuthRuntime, Depends(auth_runtime)]) -> JwtKeys:
    if runtime.keys is None:
        raise ServiceUnavailable(detail="JWT_PRIVATE_KEY is not configured")
    return runtime.keys


async def current_identity(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    db: Annotated[Database, Depends(get_database)],
) -> RequestIdentity:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise Unauthorized()
    token = credentials.credentials
    if is_mmlabs_token(token):
        verifier: MmlabsVerifier = request.app.state.mmlabs
        try:
            claims = await verifier.verify(token)
        except InvalidMmlabsToken as exc:
            raise Unauthorized(detail=f"mmlabs token rejected: {exc}") from None
        except MmlabsUnavailable:
            raise ServiceUnavailable(detail="mmlabs signing keys unavailable") from None
        role = role_from_roles(claims.roles)
        async with db.role_transaction(SERVICE) as conn:
            user_id = await resolve_user(conn, claims, role)
        return RequestIdentity(user_id, role)
    # Legacy ricotdin token (removed in AUT-06).
    keys: JwtKeys | None = request.app.state.auth.keys
    if keys is None:
        raise Unauthorized()
    try:
        legacy = verify_access_token(keys, token)
    except InvalidAccessToken as exc:
        raise Unauthorized(detail=f"access token rejected: {exc}") from None
    return RequestIdentity(legacy.user_id, legacy.role)


def require_admin(
    identity: Annotated[RequestIdentity, Depends(current_identity)],
) -> RequestIdentity:
    if identity.role != "admin":
        raise Forbidden()
    return identity


def client_ip(request: Request) -> str | None:
    """Peer address; behind a proxy uvicorn rewrites it from X-Forwarded-For only for
    FORWARDED_ALLOW_IPS (CLAUDE.md §0.2)."""
    return request.client.host if request.client else None


def ip_key(host: str | None) -> str:
    """Rate-limit key for a client address: IPv6 by /64 (one host usually owns a whole /64)."""
    if not host:
        return "?"
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return host
    if addr.version == 6:
        return str(ipaddress.ip_network(f"{addr}/64", strict=False))
    return str(addr)
