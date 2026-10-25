"""HTTP plumbing (ARC-04): security headers, CORS allow-list, error → response mapping."""

from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from app.core.errors import AppError, to_http
from app.core.logging import get_logger
from app.core.redact import redact

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Cross-Origin-Resource-Policy": "same-site",
}

log = get_logger("http")


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        response = await call_next(request)
        for name, value in SECURITY_HEADERS.items():
            response.headers.setdefault(name, value)
        return response


def install_cors(app: FastAPI, origins: list[str]) -> None:
    """Exact-origin allow-list; credentials allowed (refresh cookie, ARC-05). Empty = none."""
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
        max_age=600,
    )


def _json(status: int, body: dict[str, Any], headers: dict[str, str] | None = None) -> JSONResponse:
    return JSONResponse(status_code=status, content=body, headers=headers)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError) -> JSONResponse:
        log.warning(
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
        fields = [".".join(str(p) for p in e.get("loc", ())) for e in exc.errors()]
        return _json(
            422,
            {
                "error": {
                    "code": "unprocessable",
                    "message": "The request is not valid.",
                    "fields": fields,
                }
            },
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
        return _json(
            exc.status_code,
            {
                "error": {
                    "code": code,
                    "message": "Not found." if exc.status_code == 404 else "Request not allowed.",
                }
            },
        )

    @app.exception_handler(Exception)
    async def _unexpected(request: Request, exc: Exception) -> JSONResponse:
        log.error(
            "unhandled %s on %s %s: %s",
            type(exc).__name__,
            request.method,
            request.url.path,
            redact(str(exc)),
            exc_info=exc,
        )
        status, body = to_http(exc)
        return _json(status, body)
