> Moved from CLAUDE.md §0.4 (ARC-19). Rules here are binding.

### 0.4 v2 platform services (ARC-06, storage ARC-17)

- **`Platform`** (`app/services/platform.py`, `app.state.platform`, `get_platform`): `keys`
  (`KeySource`), `config` (`AppConfigReader`), `drive_config`, `storage(conn)` (Google Drive),
  `media_signer`, `media_slots`; `storage_config` + `r2(conn)` only for the ARC-18 v1 source.
  Use them only inside `db.role_transaction('ricotdin_service' | 'ricotdin_worker')`;
  `ricotdin_app` cannot read `admin_config` / `storage_config` / `drive_config` / `storage_objects`.
- **Crypto** (`crypto.py`): AES-256-GCM, byte-compatible with v1 (fixture test).
  `KEY_ENCRYPTION_SECRET` must be the **same value as v1**: 64 hex chars or standard base64 of 32
  bytes. A malformed value stops startup. An unset value means stored keys and R2 are unusable;
  only an error is logged. No rotation path yet (open follow-up).
- **Keys** (`keys/source.py`, `pool.py`): active `admin_config` rows, decrypted and cached 30 s.
  If none, the env fallback (`GEMINI_API_KEYS`, then `GEMINI_API_KEY_1..20`, then
  `GEMINI_API_KEY`; `SPEECHMATICS_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` / `GROK_API_KEY`).
  A DB failure also falls back to env, cached 5 s. Keys rejected with 401 are skipped
  process-wide until `keys.invalidate(provider)`, which ARC-10 must call after every key
  mutation. No usable key raises `NoUsableKeys` (503). Pools keep cooldowns and in-flight state
  per instance, so keep one pool per provider (ARC-08), never one per request.
- **Config** (`config.py`): `app_config` reader, cache 30 s, `invalidate(key)` after an admin
  PATCH. `coerce_config_bool` / `parse_int_setting` fail closed.
- **Storage = Google Drive** (ARC-17, `storage/`; owner decision 2026-10-29). Code against the
  `Storage` protocol (`base.py`); `platform.storage(conn)` returns `DriveStorage` (`gdrive.py`).
  `r2.py` is only the ARC-18 reader of the v1 bucket (removed in ARC-16). No Google SDK (httpx2).
  - **Callers must check ownership first** (`owned_audio_path` / `is_owned_audio_key` /
    `is_owned_avatar_key`); storage accepts any key (≤ 121 bytes, the Drive appProperty limit).
  - **Account:** one row in `drive_config` (migration `0003`), written by
    `uv run --env-file .env python -m scripts.connect_gdrive [--folder NAME]` (Desktop-app OAuth
    client, consent screen *In production* — *Testing* expires the refresh token after 7 days;
    scope `drive.file`; loopback + PKCE). Client secret + refresh token AES-256-GCM with
    `KEY_ENCRYPTION_SECRET`; cached 30 s (`drive_config.invalidate()`). A revoked token →
    `StorageNotConfigured` (503) + an error log asking to re-run `connect_gdrive` (not retried for
    30 s). Check end to end with `python -m scripts.drive_smoke`. No new env var. Switching to
    another Google account / OAuth project orphans every file and needs `--force`.
  - **Suspected leak** of the refresh token or client secret: revoke the app at Google first
    (myaccount.google.com → Security → Third-party connections), add a new client secret and
    delete the old one in the Cloud console, then re-run `connect_gdrive` + `drive_smoke`, and
    review the folder's Drive activity. Re-running the script alone does not revoke anything.
    Unused refresh tokens expire after 6 months: run `drive_smoke` before go-live.
  - **`KEY_ENCRYPTION_SECRET` now also derives the `/media` token key** (HKDF): whoever holds it
    can mint playback links for any stored key. Rotating it touches `admin_config`,
    `storage_config`, `drive_config` (re-run `connect_gdrive`) and invalidates open media links.
  - **Map:** `storage_objects(key PK, file_id UNIQUE, size_bytes, content_type, md5)`; service
    read/write, worker read/write, app none. `stat`/`size` read only the map. **A key is mapped
    once:** repeating `confirm_upload` with the same file id returns the mapping (idempotent, also
    under a concurrent double submit); another file for a mapped key answers 409 `KeyAlreadyStored`
    and is discarded; to replace a file,
    `delete(key)` in its own step, then upload again (never delete inside a transaction that may
    roll back the map).
  - **Upload:** `upload_session(key, content_type, content_length, max_bytes=)` → resumable session
    URI (bearer secret: return once, never log) with `Origin: WEB_ORIGIN`; the browser PUTs the file
    and reports the file id; `confirm_upload` accepts it only if `appProperties.key`, parent, size
    (= declared, ≤ cap) and type match, else 422 `UploadRejected`. Only a rejected file that a
    session for *this* key created in the root is deleted (`is_session_orphan`) — never another
    key's file, a mapped file, a folder or the root (`delete_file` refuses the root). Media types
    only (415). Server-side: `upload_file` (8 MiB chunks following Drive's persisted offset, md5
    checked before mapping). ARC-07 must rate-limit session creation per user and allow confirm
    only while the meeting is `pending`. Orphans of never-confirmed sessions are not cleaned up
    yet (follow-up).
  - **Playback:** `media_url(key)` → path-relative `/media?t=<token>` (HMAC-SHA256 over key +
    expiry ≤ 15 min, key from HKDF of `KEY_ENCRYPTION_SECRET`); the SPA prefixes the API origin.
    `GET /media` checks the token before any DB/Drive call (403), looks the key up as
    `ricotdin_worker`, forwards `Range` (206 + `Content-Range`, 416 past the end), serves at most
    4 MiB per answer, keeps the global `no-store`, allows 8 streams per process and 2 per file
    (503 `media_busy`) and drops a client that takes no chunk for 30 s. The token is a bearer
    link in the query string: our access log drops it; **strip query strings for `/media` in the
    reverse-proxy / CDN logs too** (ARC-15 deployment).
  - **Delete:** permanent (`files.delete`, never trash), then the map row; a missing key or Drive
    404 is a no-op. Retry with backoff + jitter on 429, rate-limit 403 and 5xx, 5 attempts, then
    `StorageError` (503). `check()` → `StorageHealth` (token, root present, `shared_root` if anyone
    else has access, quota).
  - Reads always take `max_bytes`.
  - botocore, boto3, s3transfer, urllib3, httpx2 and httpcore2 log at WARNING, redacted (Google
    `ya29.`/`1//` tokens, `GOCSPX-` secrets and `upload_id=` are redaction patterns).
  - The shared `DriveClient` is never closed under live streams: a failed config lookup only
    raises; a reconnect retires the old client, which is closed at shutdown.
