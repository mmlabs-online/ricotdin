"""Google OAuth constants and pure helpers for the one-time ``connect_gdrive`` sign-in (ARC-17).

Installed-app flow: loopback redirect on 127.0.0.1 + PKCE (S256) + ``state``; scope
``drive.file`` only (the app sees just the files it created). The OAuth client must be a
"Desktop app" client whose consent screen is *In production* — in *Testing* Google expires the
refresh token after 7 days.
"""

import base64
import hashlib
import secrets
from urllib.parse import parse_qs, urlencode

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105 - endpoint, not a secret
DRIVE_API = "https://www.googleapis.com/drive/v3"
DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3"
DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"
FOLDER_MIME = "application/vnd.google-apps.folder"


class OAuthCallbackError(Exception):
    """The redirect did not carry a usable code (denied, wrong state, missing code)."""


def pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)[:96]
    digest = hashlib.sha256(verifier.encode()).digest()
    return verifier, base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def build_auth_url(client_id: str, redirect_uri: str, state: str, challenge: str) -> str:
    query = urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": DRIVE_SCOPE,
            "access_type": "offline",
            "prompt": "consent",  # always return a refresh token
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )
    return f"{AUTH_URL}?{query}"


def parse_callback(query: str, expected_state: str) -> str:
    """The authorization code from the redirect query. Errors never echo the code."""
    q = {k: v[0] for k, v in parse_qs(query, keep_blank_values=True).items()}
    if "error" in q:
        raise OAuthCallbackError(f"Google returned an error: {q['error'][:64]}")
    state = q.get("state", "")
    if not state or not secrets.compare_digest(state, expected_state):
        raise OAuthCallbackError("state mismatch (stale or forged redirect)")
    code = q.get("code", "")
    if not code:
        raise OAuthCallbackError("no authorization code in the redirect")
    return code


def folder_query(name: str) -> str:
    """Drive ``q`` for a non-trashed folder called ``name`` directly under My Drive."""
    if not name or len(name) > 100 or "/" in name or "\\" in name:
        raise ValueError("folder name must be 1-100 characters without slashes")
    escaped = name.replace("'", "\\'")
    return (
        f"name = '{escaped}' and mimeType = '{FOLDER_MIME}' "
        "and 'root' in parents and trashed = false"
    )
