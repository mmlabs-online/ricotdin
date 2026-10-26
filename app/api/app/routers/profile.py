"""Profile endpoints (ARC-05: change password; the rest of PRF-* arrives in ARC-07)."""

from datetime import UTC, datetime
from typing import Annotated

import anyio
from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field

from app.auth import service
from app.auth.deps import auth_runtime, client_ip, current_identity
from app.auth.passwords import hash_password, verify_password
from app.auth.runtime import AuthRuntime
from app.auth.validate import validate_password
from app.core.errors import Forbidden, Unauthorized, UnprocessableEntity
from app.db.context import RequestIdentity
from app.db.session import Database, get_database
from app.routers.auth import SERVICE, enforce, set_refresh_cookie

router = APIRouter(prefix="/profile", tags=["profile"])


class WrongPassword(Forbidden):
    code = "wrong_password"
    message = "Current password is incorrect."


class ChangePasswordIn(BaseModel):
    current_password: str = Field(max_length=1024)
    new_password: str = Field(max_length=1024)


@router.post("/change-password")
async def change_password(
    body: ChangePasswordIn,
    request: Request,
    response: Response,
    identity: Annotated[RequestIdentity, Depends(current_identity)],
    runtime: Annotated[AuthRuntime, Depends(auth_runtime)],
    db: Annotated[Database, Depends(get_database)],
) -> dict[str, bool]:
    """Re-authenticates with the current password; ends every other session and starts a new one
    for this browser (new refresh cookie)."""
    enforce(runtime.limiters.password_user, str(identity.user_id))
    error = validate_password(body.new_password)
    if error:
        raise UnprocessableEntity(error)
    if body.new_password == body.current_password:
        raise UnprocessableEntity("New password must be different from the current password.")
    async with db.role_transaction(SERVICE) as conn:
        user = await service.find_user_by_id(conn, identity.user_id)
    if user is None or user.disabled_at is not None:
        raise Unauthorized()
    result = await anyio.to_thread.run_sync(
        verify_password, body.current_password, user.password_hash
    )
    if not result.ok:
        raise WrongPassword()
    new_hash = await anyio.to_thread.run_sync(hash_password, body.new_password)
    async with db.role_transaction(SERVICE) as conn:
        await service.set_password_hash(conn, user.id, new_hash)
        await service.revoke_user_tokens(conn, user.id)
        token, _ = await service.issue_refresh(
            conn,
            user.id,
            ttl=runtime.refresh_ttl,
            now=datetime.now(UTC),
            ip=client_ip(request),
            user_agent=request.headers.get("user-agent"),
        )
    set_refresh_cookie(response, runtime, token)
    return {"changed": True}
