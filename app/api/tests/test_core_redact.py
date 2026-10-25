"""ARC-04: secrets never reach logs or Sentry (CLAUDE.md §5/§8: never log secret values)."""

from app.core.redact import REDACTED, redact


def test_password_in_connection_urls_is_masked() -> None:
    s = "connect postgresql://neondb_owner:Sup3rS3cret@ep-x.neon.tech/neondb?sslmode=require failed"
    out = redact(s)
    assert "Sup3rS3cret" not in out
    assert "postgresql://neondb_owner:" + REDACTED + "@ep-x.neon.tech/neondb" in out


def test_bearer_tokens_and_provider_keys_are_masked() -> None:
    s = "Authorization: Bearer eyJhbGciOi.abc.def key=AIzaSyA1234567890abcdefghijklmnopqrstu sk-proj-abcdEFGH1234567890"
    out = redact(s)
    for secret in (
        "eyJhbGciOi.abc.def",
        "AIzaSyA1234567890abcdefghijklmnopqrstu",
        "sk-proj-abcdEFGH1234567890",
    ):
        assert secret not in out


def test_mapping_values_under_secret_looking_keys_are_masked_recursively() -> None:
    data = {
        "user": "u1",
        "password": "p",
        "nested": {"SUPABASE_SERVICE_ROLE_KEY": "x", "api_key": "y", "items": [{"token": "z"}]},
        "secret_access_key": "w",
        "authorization": "Bearer t",
    }
    assert redact(data) == {
        "user": "u1",
        "password": REDACTED,
        "nested": {
            "SUPABASE_SERVICE_ROLE_KEY": REDACTED,
            "api_key": REDACTED,
            "items": [{"token": REDACTED}],
        },
        "secret_access_key": REDACTED,
        "authorization": REDACTED,
    }


def test_key_value_secrets_inside_free_text_are_masked() -> None:
    out = redact("connect failed: password=hunter2 user=bob api_key: abc123 secret='s3' token=t0k")
    for secret in ("hunter2", "abc123", "s3'", "t0k"):
        assert secret not in out
    assert "user=bob" in out


def test_harmless_values_are_untouched() -> None:
    data = {"meeting_id": "123", "status": "done", "count": 3, "ok": True, "none": None}
    assert redact(data) == data
    assert redact("plain message") == "plain message"
