"""Typed domain errors → HTTP (ARC-04; CLAUDE.md §5: typed errors in the library, mapped in the
API; user-facing messages are friendly, the detail goes to logs only)."""

from typing import Any, ClassVar


class AppError(Exception):
    """Base for expected failures. ``message`` is shown to users; ``detail`` is for logs."""

    status: ClassVar[int] = 400
    code: ClassVar[str] = "bad_request"
    message: ClassVar[str] = "The request could not be processed."

    def __init__(self, message: str | None = None, *, detail: str | None = None) -> None:
        self.public_message = message or type(self).message
        self.detail = detail
        super().__init__(detail or self.public_message)

    def extra(self) -> dict[str, Any]:
        """Additional safe fields for the response body."""
        return {}


class Unauthorized(AppError):
    status = 401
    code = "unauthorized"
    message = "Please sign in."


class Forbidden(AppError):
    status = 403
    code = "forbidden"
    message = "You do not have access to this."


class NotFound(AppError):
    status = 404
    code = "not_found"
    message = "Not found."


class Conflict(AppError):
    status = 409
    code = "conflict"
    message = "This conflicts with the current state."


class UnprocessableEntity(AppError):
    status = 422
    code = "unprocessable"
    message = "The request is not valid."


class RateLimited(AppError):
    status = 429
    code = "rate_limited"
    message = "Too many requests. Please wait and try again."

    def __init__(
        self,
        message: str | None = None,
        *,
        detail: str | None = None,
        retry_after_seconds: int | None = None,
    ) -> None:
        super().__init__(message, detail=detail)
        self.retry_after_seconds = retry_after_seconds

    def extra(self) -> dict[str, Any]:
        if self.retry_after_seconds is None:
            return {}
        return {"retry_after_seconds": self.retry_after_seconds}


_INTERNAL = {"code": "internal", "message": "Something went wrong. Please try again."}


def to_http(exc: BaseException) -> tuple[int, dict[str, Any]]:
    """(status, JSON body) for any exception; non-AppError exceptions never leak their text."""
    if isinstance(exc, AppError):
        return exc.status, {
            "error": {"code": exc.code, "message": exc.public_message, **exc.extra()}
        }
    return 500, {"error": dict(_INTERNAL)}
