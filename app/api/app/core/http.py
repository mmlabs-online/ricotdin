"""HTTP plumbing (ARC-04): catch-all, security headers, CORS allow-list, error → response mapping.

Pure ASGI middlewares (no BaseHTTPMiddleware buffering, streaming-friendly). Order, outermost
first: CORS → security headers → catch-all → app. The catch-all turns any unexpected exception
into the generic 500 *inside* CORS and the header middleware, so a crash still carries both and
nothing is re-raised to the server (whose traceback logging is not ours to redact).
"""

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.errors import AppError, to_http
from app.core.logging import get_logger
from app.core.redact import redact

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Cross-Origin-Resource-Policy": "same-site",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Cache-Control": "no-store",
}
_DOCS_PATHS = ("/docs", "/redoc")  # need scripts/styles; only served when API_DOCS=1
_HTTP_CODES = {
    400: ("bad_request", "The request could not be processed."),
    401: ("unauthorized", "Please sign in."),
    403: ("forbidden", "You do not have access to this."),
    404: ("not_found", "Not found."),
    405: ("method_not_allowed", "Request not allowed."),
    413: ("payload_too_large", "The request is too large."),
    429: ("rate_limited", "Too many requests. Please wait and try again."),
}

log = get_logger("http")


class SecurityHeadersMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        docs = str(scope.get("path", "")).startswith(_DOCS_PATHS)

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                present = {k.lower() for k, _ in message.get("headers", [])}
                extra = [
                    (k.lower().encode(), v.encode())
                    for k, v in SECURITY_HEADERS.items()
                    if k.lower().encode() not in present
                    and not (docs and k == "Content-Security-Policy")
                ]
                message["headers"] = [*message.get("headers", []), *extra]
            await send(message)

        await self.app(scope, receive, send_with_headers)


class CatchAllMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def tracking_send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, tracking_send)
        except Exception as exc:  # noqa: BLE001 - last line of defence, logged redacted
            log.error(
                "unhandled %s on %s %s: %s",
                type(exc).__name__,
                scope.get("method"),
                scope.get("path"),
                redact(str(exc)),
                exc_info=exc,
            )
            if started:
                return  # headers already sent: nothing safe left to do
            status, body = to_http(exc)
            await JSONResponse(status_code=status, content=body)(scope, receive, send)


def install_middleware(app: FastAPI, origins: list[str]) -> None:
    """Innermost first (Starlette wraps each added middleware around the previous ones)."""
    app.add_middleware(CatchAllMiddleware)
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,  # refresh cookie (ARC-05)
        allow_methods=["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
        expose_headers=["Retry-After"],
        max_age=600,
    )


def _json(status: int, body: dict[str, Any], headers: dict[str, str] | None = None) -> JSONResponse:
    return JSONResponse(status_code=status, content=body, headers=headers)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError) -> JSONResponse:
        log.info(
            "domain error %s %s -> %s: %s",
            request.method,
            request.url.path,
            exc.code,
            redact(exc.detail or exc.public_message),
        )
        status, body = to_http(exc)
        retry = body["error"].get("retry_after_seconds")
        return _json(status, body, {"Retry-After": str(retry)} if retry else None)

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        # Field locations only, never the submitted values.
        fields = [".".join(str(p) for p in e.get("loc", ())) for e in exc.errors()]
        body = {"error": {"code": "unprocessable", "message": "The request is not valid."}}
        body["error"]["fields"] = fields  # type: ignore[assignment]
        return _json(422, body)

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code, message = _HTTP_CODES.get(exc.status_code, ("http_error", "Request not allowed."))
        return _json(
            exc.status_code, {"error": {"code": code, "message": message}}, dict(exc.headers or {})
        )
