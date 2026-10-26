"""ARC-04 review round 1: secret shapes the first redaction missed, and false positives that
would blank out usage numbers (§9e input_tokens/output_tokens) or idempotency keys."""

import pytest

from app.core.redact import REDACTED, redact


@pytest.mark.parametrize(
    "text",
    [
        "refresh_token=abc123",
        "client_secret: xyz789",
        "db_password=p1secret",
        "password_hash='$argon2id$v=19$m=65536'",
        "{'password': 'hunter2'}",
        '{"api_key": "k123secret"}',
        "input_value='hunter2'",
        "Authorization: Basic dXNlcjpwYXNz",
        "token eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl",
        "sentry https://0123456789abcdef@o1.ingest.sentry.io/42",
    ],
)
def test_secret_shapes_are_masked(text: str) -> None:
    out = redact(text)
    for secret in (
        "abc123", "xyz789", "p1secret", "argon2id", "hunter2", "k123secret",
        "dXNlcjpwYXNz", "c2lnbmF0dXJl", "0123456789abcdef",
    ):  # fmt: skip
        assert secret not in out, out


@pytest.mark.parametrize(
    "key",
    ["input_tokens", "output_tokens", "total_tokens", "dedup_key", "bypass_cache", "token_count"],
)
def test_counts_and_ids_are_not_secrets(key: str) -> None:
    assert redact({key: 42}) == {key: 42}


@pytest.mark.parametrize(
    "key", ["password", "db_password", "access_token", "refresh_token", "api_key", "apiKey",
            "secret_access_key", "KEY_ENCRYPTION_SECRET", "authorization", "cookie", "sentry_dsn",
            "private_key", "token"],
)  # fmt: skip
def test_secret_looking_keys_are_masked(key: str) -> None:
    assert redact({key: "x"}) == {key: REDACTED}


def test_redaction_is_idempotent() -> None:
    once = redact("password=hunter2 Bearer abc.def postgresql://u:pw@h/db")
    assert redact(once) == once
    assert "]]" not in redact(once)


@pytest.mark.parametrize(
    ("text", "secret"),
    [
        ("Authorization: Token abc123def", "abc123def"),
        ("set-cookie: sid=abc; HttpOnly", "sid=abc"),
        ("cookie: refresh=r1t0k3n", "r1t0k3n"),
        ("GET /cb?access_token%3Dzz9secret", "zz9secret"),
    ],
)
def test_more_free_text_secret_shapes(text: str, secret: str) -> None:
    assert secret not in redact(text)


def test_sets_and_tuples_are_redacted() -> None:
    out = redact({"s": {"Bearer abc.def"}, "t": ("postgresql://u:pw@h/db",)})
    assert "abc.def" not in str(out) and "pw@" not in str(out)


def test_cycles_do_not_recurse_forever() -> None:
    a: dict[str, object] = {"password": "x"}
    a["self"] = a
    out = redact(a)
    assert out["password"] == REDACTED


@pytest.mark.parametrize(
    "text",
    [
        'JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIabc\n-----END PRIVATE KEY-----"',
        "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIabc\n-----END PRIVATE KEY-----",
        "private_key=MC4CAQAwBQYDK2VwBCIEIabc",
    ],
)
def test_private_keys_are_masked(text: str) -> None:
    assert "MC4CAQAwBQYDK2VwBCIEIabc" not in redact(text)
