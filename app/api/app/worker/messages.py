"""Texts the worker stores (ARC-08). Pure.

``meetings.error_message`` and ``jobs.last_error`` keep at most 500 characters, activity metadata
200 (v1). Texts are one line and pass the log redaction patterns, so a provider token that ends
up in an exception message is not stored or shown."""

from app.core.errors import AppError
from app.core.redact import redact
from app.worker.errors import PipelineError

MAX_ERROR_CHARS = 500
MAX_ACTIVITY_ERROR_CHARS = 200

MEETING_TIMED_OUT = "Processing timed out. Use the Requeue button to retry."
JOB_STUCK_FAILED = "Job timed out (stuck in running state — server may have restarted mid-step)"
DEADLINE_EXCEEDED = "Processing took too long and was stopped. Use the Requeue button to retry."


def truncate(text: str, limit: int) -> str:
    return text[:limit]


def _one_line(text: str) -> str:
    return " ".join(text.split())


def error_text(exc: BaseException) -> str:
    if isinstance(exc, PipelineError):
        text = str(exc)
    else:
        if isinstance(exc, AppError):
            message = exc.detail or exc.public_message
        else:
            message = str(exc)
        name = type(exc).__name__
        text = f"{name}: {message}" if message.strip() else name
    cleaned = redact(_one_line(text))
    return truncate(str(cleaned), MAX_ERROR_CHARS)


def activity_error(text: str) -> str:
    return truncate(text, MAX_ACTIVITY_ERROR_CHARS)


def quota_blocked_message(required: int, remaining: int) -> str:
    return (
        "QUOTA_BLOCKED: Insufficient audio balance. "
        f"Required: {required}s, remaining: {remaining}s."
    )


def stuck_requeued_message(attempts: int, max_attempts: int) -> str:
    return f"Requeued after stuck timeout (attempt {attempts}/{max_attempts})"
