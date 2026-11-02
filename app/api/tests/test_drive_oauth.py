"""ARC-17: pure pieces of the one-time Google sign-in (loopback + PKCE) used by connect_gdrive."""

import base64
import hashlib
from urllib.parse import parse_qs, urlsplit

import pytest

from app.services.storage.drive_oauth import (
    DRIVE_SCOPE,
    OAuthCallbackError,
    build_auth_url,
    folder_query,
    parse_callback,
    pkce_pair,
)


def test_pkce_pair_is_s256() -> None:
    verifier, challenge = pkce_pair()
    assert 43 <= len(verifier) <= 128
    digest = hashlib.sha256(verifier.encode()).digest()
    assert challenge == base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    assert pkce_pair()[0] != verifier


def test_auth_url_asks_for_drive_file_offline_with_pkce() -> None:
    url = build_auth_url("cid.apps.googleusercontent.com", "http://127.0.0.1:5555/", "st", "ch")
    parts = urlsplit(url)
    assert parts.scheme == "https" and parts.netloc == "accounts.google.com"
    q = {k: v[0] for k, v in parse_qs(parts.query).items()}
    assert q["scope"] == DRIVE_SCOPE == "https://www.googleapis.com/auth/drive.file"
    assert q["access_type"] == "offline"
    assert q["prompt"] == "consent"
    assert q["code_challenge_method"] == "S256"
    assert q["code_challenge"] == "ch"
    assert q["state"] == "st"
    assert q["response_type"] == "code"
    assert q["redirect_uri"] == "http://127.0.0.1:5555/"


def test_callback_returns_the_code_when_state_matches() -> None:
    assert parse_callback("code=4%2Fabc&state=st&scope=x", "st") == "4/abc"


@pytest.mark.parametrize(
    "query",
    [
        "code=abc&state=other",
        "code=abc",
        "state=st",
        "error=access_denied&state=st",
        "",
        "code=&state=st",
    ],
)
def test_callback_errors(query: str) -> None:
    with pytest.raises(OAuthCallbackError):
        parse_callback(query, "st")


def test_callback_error_does_not_echo_the_code() -> None:
    with pytest.raises(OAuthCallbackError) as exc:
        parse_callback("code=SECRETCODE&state=bad", "st")
    assert "SECRETCODE" not in str(exc.value)


def test_folder_query_escapes_quotes() -> None:
    q = folder_query("it's")
    assert "name = 'it\\'s'" in q
    assert "mimeType = 'application/vnd.google-apps.folder'" in q
    assert "'root' in parents" in q and "trashed = false" in q


@pytest.mark.parametrize("name", ["", "a/b", "x" * 101, "back\\slash"])
def test_folder_query_rejects_odd_names(name: str) -> None:
    with pytest.raises(ValueError):
        folder_query(name)
