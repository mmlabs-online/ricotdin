"""ARC-04: typed domain errors map to an HTTP status + friendly body; detail stays in logs."""

from app.core.errors import (
    AppError,
    Conflict,
    Forbidden,
    NotFound,
    RateLimited,
    Unauthorized,
    UnprocessableEntity,
    to_http,
)


def test_each_error_maps_to_its_status_and_code() -> None:
    cases = [
        (Unauthorized(), 401, "unauthorized"),
        (Forbidden(), 403, "forbidden"),
        (NotFound(), 404, "not_found"),
        (Conflict(), 409, "conflict"),
        (UnprocessableEntity(), 422, "unprocessable"),
        (RateLimited(), 429, "rate_limited"),
    ]
    for err, status, code in cases:
        got_status, body = to_http(err)
        assert (got_status, body["error"]["code"]) == (status, code)


def test_body_has_the_friendly_message_never_the_detail() -> None:
    err = NotFound("Meeting not found.", detail="meeting 123 owned by user 456, key sk-secret")
    status, body = to_http(err)
    assert status == 404
    assert body == {"error": {"code": "not_found", "message": "Meeting not found."}}
    assert "456" not in str(body) and "sk-secret" not in str(body)


def test_unknown_exceptions_become_a_generic_500() -> None:
    status, body = to_http(RuntimeError("db password=hunter2 exploded"))
    assert status == 500
    assert body == {
        "error": {"code": "internal", "message": "Something went wrong. Please try again."}
    }


def test_custom_app_error_subclass_keeps_its_own_code() -> None:
    class QuotaExceeded(AppError):
        status = 402
        code = "quota_exceeded"
        message = "You are out of quota."

    assert to_http(QuotaExceeded()) == (
        402,
        {"error": {"code": "quota_exceeded", "message": "You are out of quota."}},
    )


def test_retry_after_is_exposed_for_rate_limits() -> None:
    _, body = to_http(RateLimited(retry_after_seconds=30))
    assert body["error"]["retry_after_seconds"] == 30
