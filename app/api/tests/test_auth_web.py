"""ARC-05: refresh cookie attributes, Origin check, email links and email bodies. Pure."""

import pytest

from app.auth.cookies import REFRESH_COOKIE, REFRESH_COOKIE_PATH, origin_allowed, refresh_cookie
from app.email.templates import action_link, reset_password_email, verification_email


def test_refresh_cookie_is_httponly_secure_lax_and_scoped_to_auth() -> None:
    c = refresh_cookie("tok", max_age=3600)
    assert c["key"] == REFRESH_COOKIE and c["value"] == "tok"
    assert c["httponly"] is True and c["secure"] is True and c["samesite"] == "lax"
    assert c["path"] == REFRESH_COOKIE_PATH == "/auth"
    assert c["max_age"] == 3600
    assert "domain" not in c  # host-only: never shared with sibling subdomains


def test_cookie_name_uses_the_secure_prefix() -> None:
    assert REFRESH_COOKIE.startswith("__Secure-")


@pytest.mark.parametrize(
    ("origin", "ok"),
    [
        ("https://app.ricotdin.test", True),
        ("https://evil.test", False),
        ("https://app.ricotdin.test.evil.test", False),
        ("null", False),
        (None, False),
        ("", False),
    ],
)
def test_origin_must_be_exactly_allowed(origin: str | None, ok: bool) -> None:
    assert origin_allowed(origin, ["https://app.ricotdin.test"]) is ok


def test_links_carry_the_token_in_the_fragment() -> None:
    link = action_link("https://app.ricotdin.test", "verify-email", "abc_-1")
    assert link == "https://app.ricotdin.test/verify-email#token=abc_-1"


def test_verification_email_is_bilingual_and_contains_the_link() -> None:
    link = "https://app.ricotdin.test/verify-email#token=t"
    msg = verification_email(link)
    assert link in msg.text and link in msg.html
    assert "Verify" in msg.subject or "verify" in msg.subject.lower()
    assert "Xác minh" in msg.text  # Vietnamese part


def test_reset_email_is_bilingual_and_contains_the_link() -> None:
    link = "https://app.ricotdin.test/reset-password#token=t"
    msg = reset_password_email(link)
    assert link in msg.text and link in msg.html
    assert "mật khẩu" in msg.text


def test_html_escapes_the_link() -> None:
    msg = verification_email('https://a.test/x#token=a"><script>')
    assert "<script>" not in msg.html


def test_signing_keys_without_web_origin_refuse_to_start() -> None:
    import pytest as _pytest

    from app.auth.jwt import generate_private_pem
    from app.auth.runtime import AuthRuntime
    from app.core.settings import Settings

    settings = Settings.model_validate(
        {"JWT_PRIVATE_KEY": generate_private_pem(), "WEB_ORIGIN": ""}
    )
    with _pytest.raises(ValueError, match="WEB_ORIGIN"):
        AuthRuntime.from_settings(settings)
    ok = Settings.model_validate(
        {"JWT_PRIVATE_KEY": generate_private_pem(), "WEB_ORIGIN": "https://app.ricotdin.test"}
    )
    assert AuthRuntime.from_settings(ok).web_origin == "https://app.ricotdin.test"
