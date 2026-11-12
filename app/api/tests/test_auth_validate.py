"""ARC-05: input validation for auth (port of v1 lib/auth/validate.ts + tests). Pure."""

import pytest

from app.auth.identifier import classify_identifier
from app.auth.validate import (
    EmailState,
    normalize_email,
    normalize_username,
    registration_action,
    validate_email,
    validate_password,
    validate_username,
)


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


def test_email_needs_an_at_sign_and_a_domain() -> None:
    assert validate_email("a@b.co") is None
    assert validate_email("ab") is not None
    assert validate_email("a@") is not None
    assert validate_email("noatsign.com") is not None


def test_email_with_whitespace_or_control_chars_is_rejected() -> None:
    assert validate_email("a b@c.d") is not None
    assert validate_email("a@b.c\r\nBcc: x@y.z") is not None  # header injection into SMTP


def test_email_is_trimmed_and_lowercased() -> None:
    assert normalize_email("  Alice@Example.COM ") == "alice@example.com"


def test_password_length_bounds() -> None:
    assert validate_password("x" * 8) is None
    assert validate_password("x" * 7) == "Password must be at least 8 characters."
    assert validate_password("x" * 256) is None
    assert validate_password("x" * 257) is not None  # hashing cost is bounded


def test_identifier_with_at_sign_is_an_email() -> None:
    ident = classify_identifier("  Alice@Example.com ")
    assert ident is not None
    assert (ident.kind, ident.value) == ("email", "alice@example.com")


def test_other_identifiers_are_usernames() -> None:
    ident = classify_identifier(" Alice ")
    assert ident is not None
    assert (ident.kind, ident.value) == ("username", "alice")


@pytest.mark.parametrize("raw", ["", "   "])
def test_empty_identifier_is_none(raw: str) -> None:
    assert classify_identifier(raw) is None


@pytest.mark.parametrize(
    "bad",
    [
        "victim@corp.test,attacker@evil.test",
        "victim@corp.test;x@evil.test",
        "Name <a@b.test>",
        '"a"@b.test',
        "a@b",
        "a@@b.test",
        "a@b..test",
        "a@-b.test",
    ],
)
def test_only_a_single_plain_address_is_accepted(bad: str) -> None:
    assert validate_email(bad) is not None


@pytest.mark.parametrize("ok", ["a@b.test", "first.last+tag@sub.example.co", "x_y-z%1@a-b.vn"])
def test_plain_addresses_are_accepted(ok: str) -> None:
    assert validate_email(ok) is None


# --- SEC-05: registering an existing email ----------------------------------------------------


def test_sec05_registration_action() -> None:
    assert registration_action(None) == "create"
    assert registration_action(EmailState(verified=False, disabled=False)) == "resend"
    assert registration_action(EmailState(verified=True, disabled=False)) == "conflict"
    # a disabled account is never re-activated by a registration, verified or not
    assert registration_action(EmailState(verified=False, disabled=True)) == "conflict"
    assert registration_action(EmailState(verified=True, disabled=True)) == "conflict"
