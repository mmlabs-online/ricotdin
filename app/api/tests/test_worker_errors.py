"""ARC-08 worker: terminal vs transient errors (owner decision 2026-11-02: terminal errors are
never retried; v1 ``isTerminalError``)."""

import pytest

from app.core.errors import BadRequest, Conflict, NotFound, RateLimited, ServiceUnavailable
from app.services.keys.pool import NoUsableKeys
from app.services.storage.base import (
    ObjectTooLarge,
    StorageError,
    StorageNotConfigured,
    StorageObjectNotFound,
)
from app.worker.errors import PipelineError, TransientError, is_terminal


def test_pipeline_error_is_terminal() -> None:
    assert is_terminal(PipelineError("Invalid file: no audio stream"))


def test_transient_error_is_retried() -> None:
    assert not is_terminal(TransientError("provider timeout"))


@pytest.mark.parametrize(
    "exc", [TimeoutError("x"), OSError("disk"), RuntimeError("boom"), ValueError("bad")]
)
def test_unknown_errors_are_transient_like_v1(exc: Exception) -> None:
    assert not is_terminal(exc)


@pytest.mark.parametrize(
    "exc", [ServiceUnavailable(), StorageError(), StorageNotConfigured(), NoUsableKeys(),
            RateLimited()],
)  # fmt: skip
def test_unavailable_and_rate_limited_app_errors_are_transient(exc: Exception) -> None:
    assert not is_terminal(exc)


@pytest.mark.parametrize(
    "exc", [StorageObjectNotFound(), ObjectTooLarge(), BadRequest(), NotFound(), Conflict()]
)
def test_client_side_app_errors_never_become_valid_so_they_are_terminal(exc: Exception) -> None:
    assert is_terminal(exc)


def test_terminal_subclass_of_transient_is_still_terminal() -> None:
    class Weird(TransientError, PipelineError):
        pass

    assert is_terminal(Weird("x"))
