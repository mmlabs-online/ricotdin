"""ARC-08 worker: user-visible / stored error texts (meetings.error_message ≤ 500 chars,
activity metadata ≤ 200 chars, v1 ``describeError(err).slice(0, 500)``) and fixed messages."""

from app.core.errors import NotFound
from app.worker.errors import PipelineError
from app.worker.messages import (
    MAX_ACTIVITY_ERROR_CHARS,
    MAX_ERROR_CHARS,
    activity_error,
    error_text,
    quota_blocked_message,
    stuck_requeued_message,
    truncate,
)


def test_quota_blocked_message_is_v1_text() -> None:
    assert quota_blocked_message(125, 30) == (
        "QUOTA_BLOCKED: Insufficient audio balance. Required: 125s, remaining: 30s."
    )


def test_pipeline_error_text_is_its_message() -> None:
    assert error_text(PipelineError("Invalid file: no audio")) == "Invalid file: no audio"


def test_other_errors_carry_their_type() -> None:
    assert error_text(RuntimeError("boom")) == "RuntimeError: boom"
    assert error_text(TimeoutError()) == "TimeoutError"


def test_app_errors_use_the_detail_when_present() -> None:
    assert error_text(NotFound(detail="key is not in storage_objects")) == (
        "NotFound: key is not in storage_objects"
    )
    assert error_text(NotFound()) == "NotFound: Not found."


def test_error_text_is_one_line_truncated_and_redacted() -> None:
    text = error_text(RuntimeError("line1\n\nline2 " + "x" * 1000))
    assert "\n" not in text and text.startswith("RuntimeError: line1 line2 ")
    assert len(text) == MAX_ERROR_CHARS
    leaked = error_text(RuntimeError("Authorization: Bearer ya29.a0AfH6SMBsecretsecret"))
    assert "ya29.a0AfH6SMBsecretsecret" not in leaked


def test_activity_error_is_shorter() -> None:
    assert len(activity_error("y" * 999)) == MAX_ACTIVITY_ERROR_CHARS


def test_truncate_keeps_short_text() -> None:
    assert truncate("abc", 5) == "abc"
    assert truncate("abcdef", 3) == "abc"


def test_stuck_requeued_message() -> None:
    assert stuck_requeued_message(2, 5) == "Requeued after stuck timeout (attempt 2/5)"
