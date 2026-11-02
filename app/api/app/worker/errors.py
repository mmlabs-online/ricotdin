"""Job errors (ARC-08). Pure.

* ``PipelineError`` — terminal: bad data or configuration that a retry cannot fix (no audio
  stream, forged audio key, unknown step, unknown provider/model, a provider rejecting the
  request). The job and meeting fail at once (owner decision 2026-11-02).
* ``TransientError`` — retried with backoff until ``max_attempts``.
* Anything else is transient (network, timeouts, database hiccups), like v1, except typed
  ``AppError`` s: 503 / 429 are transient, other 4xx (object missing, too large, …) terminal.
"""

from app.core.errors import AppError, RateLimited, ServiceUnavailable


class PipelineError(Exception):
    """Terminal: never retried. The message is shown to the user (meetings.error_message)."""


class TransientError(Exception):
    """Retried with backoff."""


def is_terminal(exc: BaseException) -> bool:
    if isinstance(exc, PipelineError):
        return True
    if isinstance(exc, TransientError):
        return False
    if isinstance(exc, AppError):
        return not isinstance(exc, ServiceUnavailable | RateLimited)
    return False
