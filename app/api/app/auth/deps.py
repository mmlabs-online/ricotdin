"""FastAPI dependencies for authenticated routes (ARC-05).

``current_identity`` turns a verified bearer access token into the ``RequestIdentity`` used by
``db.app_transaction`` (CLAUDE.md §0.1 R5: values only from the verified token). The role in the
token was read from ``users.role`` when it was issued; a change applies on the next refresh
(≤ 15 minutes, owner decision 2026-10-26).
"""

from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.auth.jwt import InvalidAccessToken, JwtKeys, verify_access_token
from app.auth.runtime import AuthRuntime
from app.core.errors import Forbidden, ServiceUnavailable, Unauthorized
from app.db.context import RequestIdentity

_bearer = HTTPBearer(auto_error=False, description="Access token from /auth/login or /auth/refresh")


def auth_runtime(request: Request) -> AuthRuntime:
    runtime: AuthRuntime = request.app.state.auth
    return runtime


def signing_keys(runtime: Annotated[AuthRuntime, Depends(auth_runtime)]) -> JwtKeys:
    if runtime.keys is None:
        raise ServiceUnavailable(detail="JWT_PRIVATE_KEY is not configured")
    return runtime.keys


def current_identity(
    keys: Annotated[JwtKeys, Depends(signing_keys)],
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> RequestIdentity:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise Unauthorized()
    try:
        claims = verify_access_token(keys, credentials.credentials)
    except InvalidAccessToken as exc:
        raise Unauthorized(detail=f"access token rejected: {exc}") from None
    return RequestIdentity(claims.user_id, claims.role)


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
