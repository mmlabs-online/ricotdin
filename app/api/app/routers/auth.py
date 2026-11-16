"""``GET /auth/me`` (ARC-05, AUT-06): the ricotdin user behind the caller's mmlabs access token.

Sign-in, sign-up, email verification and password reset all happen at mmlabs (AUT-05); ricotdin's
own register / login / refresh / email routes were removed in AUT-06 (CLAUDE.md §0.3a).
"""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.auth import service
from app.auth.deps import current_identity
from app.core.errors import Unauthorized
from app.db.context import RequestIdentity
from app.db.session import Database, get_database

SERVICE = "ricotdin_service"

router = APIRouter(prefix="/auth", tags=["auth"])

Db = Annotated[Database, Depends(get_database)]


class UserOut(BaseModel):
    id: str
    email: str
    username: str | None
    role: Literal["user", "admin"]


@router.get("/me", response_model=UserOut)
async def me(identity: Annotated[RequestIdentity, Depends(current_identity)], db: Db) -> UserOut:
    async with db.role_transaction(SERVICE) as conn:
        user = await service.find_user_by_id(conn, identity.user_id)
    if user is None or user.disabled_at is not None:
        raise Unauthorized()
    return UserOut(**user.public())
