"""Connect the owner's Google Drive to v2 storage — run once, and again to reconnect (ARC-17).

    cd app/api
    uv run --env-file .env python -m scripts.connect_gdrive                 # folder "ricotdin"
    uv run --env-file .env python -m scripts.connect_gdrive --folder ricotdin-rehearsal

Prerequisites (Google Cloud console, owner's project):
  1. Enable the Google Drive API.
  2. OAuth consent screen: External, publishing status **In production** (in Testing the
     refresh token expires after 7 days), scope ``.../auth/drive.file`` only.
  3. Credentials → OAuth client ID → type **Desktop app**. Keep its client id and secret.

The script asks for the client id and secret (the secret is not echoed), opens the Google sign-in
in a browser with a loopback redirect to 127.0.0.1 + PKCE, finds or creates the root folder under
My Drive, refuses a folder shared with anyone else, and stores client id, client secret, refresh
token (AES-256-GCM with KEY_ENCRYPTION_SECRET), folder id and account email in ``drive_config``.

Env: ``DATABASE_URL_SERVICE`` (written by ``scripts.provision_db_roles``) and
``KEY_ENCRYPTION_SECRET``. Prints only the account email, folder name and folder id.
After reconnecting, restart the API (or wait 30 s for the config cache).

Rotating after a suspected leak: FIRST revoke the old grant at Google (myaccount.google.com →
Security → Third-party connections → remove the app) and replace the client secret in the Cloud
console, THEN run this script. Re-running alone does not revoke the old refresh token.
Reconnecting a different Google account or OAuth project orphans every stored file (drive.file
only sees files this project created in that account), so it needs ``--force``.
"""

import argparse
import getpass
import http.server
import os
import secrets
import sys
import threading
import webbrowser
from typing import Any
from urllib.parse import urlsplit

import httpx2
import psycopg

from app.services.crypto import encrypt_with_key, parse_master_key
from app.services.storage.drive_oauth import (
    DRIVE_API,
    FOLDER_MIME,
    TOKEN_URL,
    OAuthCallbackError,
    build_auth_url,
    folder_query,
    parse_callback,
    pkce_pair,
)
from app.services.storage.drive_rules import is_valid_file_id, root_is_private

TIMEOUT_S = 300


class _Callback(http.server.BaseHTTPRequestHandler):
    query: str | None = None

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        type(self).query = urlsplit(self.path).query
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"Ricotdin: Google sign-in received. You can close this tab.\n")

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - quiet: path has the code
        return


def _wait_for_code(client_id: str, port: int) -> tuple[str, str, str]:
    """(code, verifier, redirect_uri) after the owner signs in."""
    server = http.server.HTTPServer(("127.0.0.1", port), _Callback)
    redirect_uri = f"http://127.0.0.1:{server.server_port}/"
    verifier, challenge = pkce_pair()
    state = secrets.token_urlsafe(24)
    url = build_auth_url(client_id, redirect_uri, state, challenge)
    print("Open this URL in a browser and sign in with the Google account that owns the Drive:")
    print(url)
    webbrowser.open(url)
    server.timeout = TIMEOUT_S
    thread = threading.Thread(target=server.handle_request, daemon=True)
    thread.start()
    thread.join(TIMEOUT_S + 5)
    server.server_close()
    if _Callback.query is None:
        raise OAuthCallbackError("no redirect received within 5 minutes")
    return parse_callback(_Callback.query, state), verifier, redirect_uri


def _check(resp: httpx2.Response, what: str) -> Any:
    if resp.status_code not in (200, 201):
        raise SystemExit(f"{what} failed: HTTP {resp.status_code}")  # never print the body
    return resp.json()


def _root_folder(http: httpx2.Client, name: str) -> str:
    found = _check(
        http.get(
            f"{DRIVE_API}/files",
            params={"q": folder_query(name), "fields": "files(id)", "spaces": "drive"},
        ),
        "folder search",
    ).get("files", [])
    if len(found) > 1:
        raise SystemExit(f"more than one folder named {name!r} created by this app; remove one")
    if found:
        return str(found[0]["id"])
    created = _check(
        http.post(
            f"{DRIVE_API}/files",
            params={"fields": "id"},
            json={"name": name, "mimeType": FOLDER_MIME, "parents": ["root"]},
        ),
        "folder create",
    )
    return str(created["id"])


def _current(url: str) -> tuple[str, str] | None:
    """(client_id, account_email) of the stored connection, if any."""
    with psycopg.connect(url) as conn:
        conn.execute("SET ROLE ricotdin_service")
        row = conn.execute("SELECT client_id, account_email FROM drive_config").fetchone()
    return (str(row[0]), str(row[1])) if row else None


def _store(url: str, master: bytes, values: dict[str, str]) -> None:
    sec = encrypt_with_key(values["client_secret"], master)
    ref = encrypt_with_key(values["refresh_token"], master)
    with psycopg.connect(url) as conn:
        conn.execute("SET ROLE ricotdin_service")
        conn.execute(
            """
            INSERT INTO drive_config (id, client_id, client_secret_ciphertext, client_secret_iv,
              client_secret_auth_tag, refresh_token_ciphertext, refresh_token_iv,
              refresh_token_auth_tag, root_folder_id, account_email)
            VALUES (true, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET client_id = EXCLUDED.client_id,
              client_secret_ciphertext = EXCLUDED.client_secret_ciphertext,
              client_secret_iv = EXCLUDED.client_secret_iv,
              client_secret_auth_tag = EXCLUDED.client_secret_auth_tag,
              refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
              refresh_token_iv = EXCLUDED.refresh_token_iv,
              refresh_token_auth_tag = EXCLUDED.refresh_token_auth_tag,
              root_folder_id = EXCLUDED.root_folder_id,
              account_email = EXCLUDED.account_email, updated_at = now()
            """,
            (
                values["client_id"],
                sec.ciphertext,
                sec.iv,
                sec.auth_tag,
                ref.ciphertext,
                ref.iv,
                ref.auth_tag,
                values["root_folder_id"],
                values["account_email"],
            ),
        )
        conn.commit()


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--folder", default="ricotdin", help="root folder under My Drive")
    parser.add_argument("--client-id", default="", help="OAuth client id (prompted if omitted)")
    parser.add_argument("--port", type=int, default=0, help="loopback port (default: random)")
    parser.add_argument(
        "--force",
        action="store_true",
        help="allow switching to another Google account or OAuth client (orphans stored files)",
    )
    args = parser.parse_args()
    db_url = os.environ.get("DATABASE_URL_SERVICE", "")
    raw_master = os.environ.get("KEY_ENCRYPTION_SECRET", "")
    if not db_url or not raw_master:
        print("DATABASE_URL_SERVICE and KEY_ENCRYPTION_SECRET must be set", file=sys.stderr)
        return 2
    master = parse_master_key(raw_master)
    try:
        current = _current(db_url)
    except psycopg.Error as exc:  # never print psycopg messages: DETAIL can quote row values
        print(f"database error {type(exc).__name__} ({exc.sqlstate})", file=sys.stderr)
        return 1
    folder_query(args.folder)  # validate the name before signing in
    client_id = args.client_id or input("OAuth client id: ").strip()
    client_secret = getpass.getpass("OAuth client secret (not shown): ").strip()
    if not client_id or not client_secret:
        print("client id and secret are required", file=sys.stderr)
        return 2
    try:
        code, verifier, redirect_uri = _wait_for_code(client_id, args.port)
    except OAuthCallbackError as exc:
        print(f"sign-in failed: {exc}", file=sys.stderr)
        return 1
    with httpx2.Client(timeout=30.0) as http:
        tokens = _check(
            http.post(
                TOKEN_URL,
                data={
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "code": code,
                    "code_verifier": verifier,
                    "redirect_uri": redirect_uri,
                    "grant_type": "authorization_code",
                },
            ),
            "token exchange",
        )
        refresh = tokens.get("refresh_token")
        if not refresh:
            print("Google returned no refresh token; revoke the app's access and retry")
            return 1
        http.headers["Authorization"] = f"Bearer {tokens['access_token']}"
        email = str(
            _check(
                http.get(f"{DRIVE_API}/about", params={"fields": "user(emailAddress)"}), "about"
            )["user"]["emailAddress"]
        )
        root = _root_folder(http, args.folder)
        if not is_valid_file_id(root):
            print("unexpected folder id from Drive", file=sys.stderr)
            return 1
        perms = _check(
            http.get(
                f"{DRIVE_API}/files/{root}/permissions",
                params={"fields": "permissions(type,role,emailAddress)"},
            ),
            "permissions",
        ).get("permissions", [])
        if not root_is_private(perms, email):
            print(
                f"folder {args.folder!r} is shared with others; unshare it first", file=sys.stderr
            )
            return 1
    if current and current != (client_id, email) and not args.force:
        print(
            "drive_config holds another Google account or OAuth client; stored files would be "
            "unreachable. Re-run with --force to switch anyway.",
            file=sys.stderr,
        )
        return 2
    try:
        _store(
            db_url,
            master,
            {
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": str(refresh),
                "root_folder_id": root,
                "account_email": email,
            },
        )
    except psycopg.Error as exc:
        print(f"database error {type(exc).__name__} ({exc.sqlstate})", file=sys.stderr)
        return 1
    print(f"Connected {email}: folder {args.folder!r} ({root}) stored in drive_config.")
    print("Next: uv run --env-file .env python -m scripts.drive_smoke")
    return 0


if __name__ == "__main__":
    sys.exit(main())
