"""Texts the worker stores (ARC-08). Pure.

* ``user_message`` → ``meetings.error_message`` (users see it) and activity metadata: only text
  written for users — a ``PipelineError`` message, an ``AppError`` public message, else a generic
  text. Never internal detail (ffmpeg stderr, driver errors, paths).
* ``error_text`` → ``jobs.last_error`` (admin only) and logs: the full detail.
Both are one line, at most 500 characters (activity 200), and pass the log redaction patterns."""

from app.core.errors import AppError
from app.core.redact import redact
from app.worker.errors import PipelineError

MAX_ERROR_CHARS = 500
MAX_ACTIVITY_ERROR_CHARS = 200

MEETING_TIMED_OUT = "Processing timed out. Use the Requeue button to retry."
JOB_STUCK_FAILED = "Job timed out (stuck in running state — server may have restarted mid-step)"
GENERIC_FAILURE = "Processing failed. Please try again or contact an administrator."
DEADLINE_EXCEEDED = "Processing took too long and was stopped. Use the Requeue button to retry."


def truncate(text: str, limit: int) -> str:
    return text[:limit]


def _one_line(text: str) -> str:
    return " ".join(text.split())


def _clean(text: str) -> str:
    return truncate(str(redact(_one_line(text))), MAX_ERROR_CHARS)


def error_text(exc: BaseException) -> str:
    """Full detail for jobs.last_error and logs."""
    if isinstance(exc, PipelineError):
        text = f"{exc} — {exc.detail}" if exc.detail else str(exc)
    else:
        if isinstance(exc, AppError):
            message = exc.detail or exc.public_message
        else:
            message = str(exc)
        name = type(exc).__name__
        text = f"{name}: {message}" if message.strip() else name
    return _clean(text)


def user_message(exc: BaseException) -> str:
    """What the meeting shows: never internal detail."""
    if isinstance(exc, PipelineError):
        return _clean(str(exc))
    if isinstance(exc, AppError):
        return _clean(exc.public_message)
    return GENERIC_FAILURE


def activity_error(text: str) -> str:
    return truncate(text, MAX_ACTIVITY_ERROR_CHARS)


def quota_blocked_message(required: int, remaining: int) -> str:
    return (
        "QUOTA_BLOCKED: Insufficient audio balance. "
        f"Required: {required}s, remaining: {remaining}s."
    )


def stuck_requeued_message(attempts: int, max_attempts: int) -> str:
    return f"Requeued after stuck timeout (attempt {attempts}/{max_attempts})"
