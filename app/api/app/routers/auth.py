"""Auth endpoints (ARC-05; replaces Supabase Auth, §9b).

Rules kept from v1: role is never client-writable (always 'user' on register), username → email
lookup stays server-side, unknown identifier and wrong password give the same answer, unverified
(403 verify) ≠ disabled (403 disabled) and both are revealed only after a correct password.
Refresh token: opaque, rotated on use, HttpOnly cookie on ``/auth``; reuse revokes its family.
"""

import time
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError

from app.auth import service
from app.auth.cookies import REFRESH_COOKIE, REFRESH_COOKIE_PATH, origin_allowed, refresh_cookie
from app.auth.deps import auth_runtime, client_ip, current_identity, ip_key, signing_keys
from app.auth.identifier import classify_identifier
from app.auth.jwt import ACCESS_TTL, JwtKeys, issue_access_token
from app.auth.passwords import hash_password, verify_dummy, verify_password
from app.auth.runtime import RESET_TTL, VERIFY_TTL, AuthRuntime
from app.auth.validate import (
    EmailState,
    normalize_email,
    normalize_username,
    registration_action,
    validate_email,
    validate_password,
    validate_username,
)
from app.core.errors import (
    AppError,
    Conflict,
    Forbidden,
    RateLimited,
    Unauthorized,
    UnprocessableEntity,
    to_http,
)
from app.core.logging import get_logger
from app.core.ratelimit import RateLimiter
from app.db.context import RequestIdentity
from app.db.session import Database, get_database
from app.email.sender import MailFailed, MailNotConfigured
from app.email.templates import EmailMessage, action_link, reset_password_email, verification_email

log = get_logger("auth")
router = APIRouter(prefix="/auth", tags=["auth"])
wellknown = APIRouter(tags=["auth"])

SERVICE = "ricotdin_service"
GENERIC_LOGIN_ERROR = "Invalid credentials. Please check your email or username and password."


class InvalidCredentials(Unauthorized):
    code = "invalid_credentials"
    message = GENERIC_LOGIN_ERROR


class EmailNotVerified(Forbidden):
    code = "email_not_verified"
    message = (
        "Please verify your email before signing in. Check your inbox for the verification link."
    )


class AccountDisabled(Forbidden):
    code = "account_disabled"
    message = "Your account has been disabled. Please contact an administrator."


class OriginRejected(Forbidden):
    code = "origin_rejected"


class InvalidLink(AppError):
    status = 400
    code = "invalid_token"
    message = "This link is invalid or has expired."


# --- models -----------------------------------------------------------------------------


class RegisterIn(BaseModel):
    email: str = Field(max_length=320)
    username: str = Field(max_length=100)
    password: str = Field(max_length=1024)


class RegisterOut(BaseModel):
    verify_email: Literal[True] = True
    email_sent: bool


class LoginIn(BaseModel):
    identifier: str = Field(max_length=320)
    password: str = Field(max_length=1024)


class UserOut(BaseModel):
    id: str
    email: str
    username: str | None
    role: Literal["user", "admin"]


class TokenOut(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"  # noqa: S105 - OAuth token type, not a secret
    expires_in: int
    user: UserOut


class EmailIn(BaseModel):
    email: str = Field(max_length=320)


class ResetIn(BaseModel):
    token: str = Field(max_length=200)
    password: str = Field(max_length=1024)


class Accepted(BaseModel):
    ok: Literal[True] = True


# --- helpers -----------------------------------------------------------------------------


def enforce(limiter: RateLimiter, key: str) -> None:
    decision = limiter.check(key, now=time.monotonic())
    if not decision.allowed:
        raise RateLimited(retry_after_seconds=decision.retry_after_seconds)


def _now() -> datetime:
    return datetime.now(UTC)


def token_response(keys: JwtKeys, user: service.UserRow) -> TokenOut:
    return TokenOut(
        access_token=issue_access_token(keys, user.id, user.role),
        expires_in=int(ACCESS_TTL.total_seconds()),
        user=UserOut(**user.public()),
    )


def set_refresh_cookie(response: Response, runtime: AuthRuntime, token: str) -> None:
    response.set_cookie(**refresh_cookie(token, int(runtime.refresh_ttl.total_seconds())))


def clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(
        REFRESH_COOKIE, path=REFRESH_COOKIE_PATH, secure=True, httponly=True, samesite="lax"
    )


def require_origin(request: Request, runtime: AuthRuntime) -> None:
    if not origin_allowed(request.headers.get("origin"), runtime.origins):
        raise OriginRejected(detail="cookie endpoint called without an allowed Origin")


async def send_mail(runtime: AuthRuntime, to: str, message: EmailMessage) -> bool:
    try:
        await runtime.mailer.send(to, message)
    except (MailNotConfigured, MailFailed, OSError, TimeoutError) as exc:
        log.error("email not sent", extra={"error": type(exc).__name__})
        return False
    return True


def link(runtime: AuthRuntime, path: str, token: str) -> str:
    # AuthRuntime refuses to start with signing keys but no WEB_ORIGIN; every caller has keys.
    assert runtime.web_origin is not None  # noqa: S101
    return action_link(runtime.web_origin, path, token)


Runtime = Annotated[AuthRuntime, Depends(auth_runtime)]
Keys = Annotated[JwtKeys, Depends(signing_keys)]
Db = Annotated[Database, Depends(get_database)]


# --- endpoints -----------------------------------------------------------------------------


@router.post("/register", status_code=201, response_model=RegisterOut)
async def register(
    body: RegisterIn, request: Request, runtime: Runtime, db: Db, _: Keys
) -> RegisterOut:
    enforce(runtime.limiters.register_ip, ip_key(client_ip(request)))
    email = normalize_email(body.email)
    username = normalize_username(body.username)
    for error in (
        validate_email(email),
        validate_username(username),
        validate_password(body.password),
    ):
        if error:
            raise UnprocessableEntity(error)
    password_hash = await runtime.run_hash(hash_password, body.password)
    try:
        async with db.role_transaction(SERVICE) as conn:
            existing = await service.find_user_by_email(conn, email)
            owner = await service.username_owner(conn, username)
            # The account's own username is not "taken" when its owner registers again (SEC-05).
            if owner is not None and (existing is None or owner != existing.id):
                raise Conflict("That username is already taken. Please choose another.")
            action = registration_action(
                None
                if existing is None
                else EmailState(
                    verified=existing.email_verified_at is not None,
                    disabled=existing.disabled_at is not None,
                )
            )
            if action == "conflict":
                raise Conflict("An account with that email already exists.")
            if existing is not None:
                # Unverified account (SEC-05): no second account, and the new username and
                # password are dropped. The inbox owner gets a fresh verify link (the old one
                # stops working), which sets the password; the answer is a new registration's.
                enforce(runtime.limiters.email_address, f"verify_email:{email}")
                user_id = existing.id
            else:
                user_id = await service.create_user(conn, email, username, password_hash)
            token = await service.issue_email_token(
                conn, user_id, "verify_email", ttl=VERIFY_TTL, now=_now()
            )
    except IntegrityError:  # concurrent registration with the same email/username
        raise Conflict("That email or username is already taken.") from None
    sent = await send_mail(runtime, email, verification_email(link(runtime, "verify-email", token)))
    return RegisterOut(email_sent=sent)


@router.post("/login", response_model=TokenOut)
async def login(
    body: LoginIn, request: Request, response: Response, runtime: Runtime, keys: Keys, db: Db
) -> TokenOut:
    require_origin(request, runtime)  # sets the session cookie: no login CSRF from siblings
    ip = client_ip(request)
    client = ip_key(ip)
    enforce(runtime.limiters.login_ip, client)
    ident = classify_identifier(body.identifier)
    if ident is None or not body.password:
        raise InvalidCredentials()
    async with db.role_transaction(SERVICE) as conn:
        if ident.kind == "email":
            user = await service.find_user_by_email(conn, ident.value)
        else:
            user = await service.find_user_by_username(conn, ident.value)
    # Email and username of one account share a bucket; unknown identifiers get their own.
    account = str(user.id) if user else f"{ident.kind}:{ident.value}"
    enforce(runtime.limiters.login_account_ip, f"{account}|{client}")
    enforce(runtime.limiters.login_account, account)
    if user is None:
        await runtime.run_hash(verify_dummy, body.password)
        raise InvalidCredentials()
    result = await runtime.run_hash(verify_password, body.password, user.password_hash)
    if not result.ok:
        raise InvalidCredentials()
    if user.disabled_at is not None:
        raise AccountDisabled()
    if user.email_verified_at is None:
        raise EmailNotVerified()
    new_hash = await runtime.run_hash(hash_password, body.password) if result.needs_rehash else None
    ua = request.headers.get("user-agent")
    async with db.role_transaction(SERVICE) as conn:
        locked = await service.lock_credentials(conn, user.id)
        # A reset / password change / disable committed since we read the row: that wins.
        if locked is None or locked[0] != user.password_hash:
            raise InvalidCredentials()
        if locked[1] is not None:
            raise AccountDisabled()
        if new_hash:
            await service.set_password_hash(conn, user.id, new_hash)
        await service.mark_signed_in(conn, user.id)
        token, _ = await service.issue_refresh(
            conn, user.id, ttl=runtime.refresh_ttl, now=_now(), ip=ip, user_agent=ua
        )
        await service.log_activity(conn, user.id, "login", ip, ua)
    set_refresh_cookie(response, runtime, token)
    return token_response(keys, user)


def _unauthorized_clearing_cookie() -> JSONResponse:
    status, body = to_http(Unauthorized())
    response = JSONResponse(status_code=status, content=body)
    clear_refresh_cookie(response)
    return response


@router.post("/refresh", response_model=TokenOut, responses={401: {}, 403: {}})
async def refresh(
    request: Request, response: Response, runtime: Runtime, keys: Keys, db: Db
) -> Any:
    require_origin(request, runtime)
    token = request.cookies.get(REFRESH_COOKIE)
    if not token:
        return _unauthorized_clearing_cookie()
    async with db.role_transaction(SERVICE) as conn:
        result = await service.rotate_refresh(
            conn,
            token,
            ttl=runtime.refresh_ttl,
            now=_now(),
            ip=client_ip(request),
            user_agent=request.headers.get("user-agent"),
        )
    # Revocations above are committed before answering.
    if result.outcome == "raced":
        # Another tab (or a retry) rotated this token < 10 s ago and got the new cookie. The jar is
        # shared, so clearing the cookie here would sign every tab out at their next refresh.
        status, body = to_http(Unauthorized())
        return JSONResponse(status_code=status, content=body)
    if result.outcome != "ok" or result.user is None or result.token is None:
        return _unauthorized_clearing_cookie()
    set_refresh_cookie(response, runtime, result.token)
    return token_response(keys, result.user)


@router.post("/logout", status_code=204)
async def logout(request: Request, runtime: Runtime, db: Db) -> Response:
    require_origin(request, runtime)
    token = request.cookies.get(REFRESH_COOKIE)
    if token:
        async with db.role_transaction(SERVICE) as conn:
            user_id = await service.revoke_refresh_family_of(conn, token)
            if user_id:
                await service.log_activity(
                    conn, user_id, "logout", client_ip(request), request.headers.get("user-agent")
                )
    response = Response(status_code=204)
    clear_refresh_cookie(response)
    return response


@router.post("/verify-email")
async def verify_email(
    body: ResetIn, request: Request, runtime: Runtime, db: Db
) -> dict[str, bool]:
    """The verify link also sets the password (SEC-05): only the inbox owner can finish an account,
    so a password chosen by whoever registered the address first never survives verification."""
    enforce(runtime.limiters.token_ip, ip_key(client_ip(request)))
    error = validate_password(body.password)
    if error:
        raise UnprocessableEntity(error)  # before the token is touched: it stays usable
    async with db.role_transaction(SERVICE) as conn:
        user_id = await service.find_email_token(conn, body.token, "verify_email", now=_now())
        if user_id is not None:
            password_hash = await runtime.run_hash(hash_password, body.password)
            await service.consume_email_token(conn, body.token, "verify_email", now=_now())
            await service.set_password_hash(conn, user_id, password_hash)
            await service.mark_email_verified(conn, user_id)
            await service.revoke_user_tokens(conn, user_id)
    if user_id is None:
        raise InvalidLink()
    return {"verified": True}


async def _email_flow(
    request: Request,
    background: BackgroundTasks,
    runtime: AuthRuntime,
    db: Database,
    raw_email: str,
    purpose: service.EmailPurpose,
) -> None:
    """Same answer whether or not the address has an account; mail goes out after the response."""
    enforce(runtime.limiters.email_ip, ip_key(client_ip(request)))
    email = normalize_email(raw_email)
    if validate_email(email):
        return
    enforce(runtime.limiters.email_address, f"{purpose}:{email}")
    async with db.role_transaction(SERVICE) as conn:
        user = await service.find_user_by_email(conn, email)
        if user is None or user.disabled_at is not None:
            return
        if purpose == "verify_email" and user.email_verified_at is not None:
            return
        ttl = VERIFY_TTL if purpose == "verify_email" else RESET_TTL
        token = await service.issue_email_token(conn, user.id, purpose, ttl=ttl, now=_now())
    if purpose == "verify_email":
        message = verification_email(link(runtime, "verify-email", token))
    else:
        message = reset_password_email(link(runtime, "reset-password", token))
    background.add_task(send_mail, runtime, user.email, message)


@router.post("/resend-verification", status_code=202, response_model=Accepted)
async def resend_verification(
    body: EmailIn, request: Request, background: BackgroundTasks, runtime: Runtime, db: Db
) -> Accepted:
    await _email_flow(request, background, runtime, db, body.email, "verify_email")
    return Accepted()


@router.post("/forgot-password", status_code=202, response_model=Accepted)
async def forgot_password(
    body: EmailIn, request: Request, background: BackgroundTasks, runtime: Runtime, db: Db
) -> Accepted:
    await _email_flow(request, background, runtime, db, body.email, "reset_password")
    return Accepted()


@router.post("/reset-password")
async def reset_password(
    body: ResetIn, request: Request, runtime: Runtime, db: Db
) -> dict[str, bool]:
    enforce(runtime.limiters.token_ip, ip_key(client_ip(request)))
    error = validate_password(body.password)
    if error:
        raise UnprocessableEntity(error)
    async with db.role_transaction(SERVICE) as conn:
        # Check the token before spending a hash on it (a junk token costs one indexed lookup).
        user_id = await service.find_email_token(conn, body.token, "reset_password", now=_now())
        if user_id is not None:
            password_hash = await runtime.run_hash(hash_password, body.password)
            await service.consume_email_token(conn, body.token, "reset_password", now=_now())
            await service.set_password_hash(conn, user_id, password_hash)
            await service.mark_email_verified(conn, user_id)  # the inbox owner proved it
            await service.revoke_user_tokens(conn, user_id)  # every existing session ends
    if user_id is None:
        raise InvalidLink()
    return {"reset": True}


@router.get("/me", response_model=UserOut)
async def me(identity: Annotated[RequestIdentity, Depends(current_identity)], db: Db) -> UserOut:
    async with db.role_transaction(SERVICE) as conn:
        user = await service.find_user_by_id(conn, identity.user_id)
    if user is None or user.disabled_at is not None:
        raise Unauthorized()
    return UserOut(**user.public())


@wellknown.get("/.well-known/jwks.json")
def jwks(keys: Keys) -> dict[str, Any]:
    return keys.jwks()
