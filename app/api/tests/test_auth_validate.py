"""ARC-05: username validation (port of v1 lib/auth/validate.ts + tests). Pure."""

import pytest

from app.auth.validate import normalize_username, validate_username


def test_username_is_lowercased_and_trimmed() -> None:
    assert normalize_username("  Alice_01 ") == "alice_01"


@pytest.mark.parametrize("name", ["abc", "a-b_c", "user123", "x" * 30])
def test_valid_usernames(name: str) -> None:
    assert validate_username(name) is None


@pytest.mark.parametrize(
    ("name", "fragment"),
    [
        ("ab", "at least 3"),
        ("x" * 31, "at most 30"),
        ("Alice", "lowercase"),
        ("a b", "lowercase"),
        ("a.b", "lowercase"),
        ("ä_bc", "lowercase"),
    ],
)
def test_invalid_usernames(name: str, fragment: str) -> None:
    err = validate_username(name)
    assert err is not None and fragment in err
