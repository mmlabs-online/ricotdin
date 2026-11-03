# CLAUDE.md

Project memory for Claude Code. Read this fully at the start of every session.
Keep it updated as the project evolves — this file is the source of truth.

## 0. v2 re-platform (module ARC) — read first

The repo is mid-migration (roadmap 2026-10-25; specs in `ai-instruction/features/feature-Architecture-ARC.md`,
progress in `ai-instruction/tracking.md` ARC rows). Since **ARC-00**:

```
legacy/          v1 — the Next.js + Supabase app described in §1–§11 (frozen: hotfixes only, release/1.1)
app/api/         v2 backend — FastAPI, Python 3.12, uv (ARC-02..ARC-10)
app/web/         v2 frontend — Vite + React SPA (Figma Make import in ARC-11)
ai-instruction/  shared: tracking, features, bugs, roadmap, ai-gen/ (runtime pipeline prompt)
docs/  .claude/  .github/  CLAUDE.md  CHANGELOG.md  README.md   shared
```

- **Every v1 path in §1–§11 is relative to `legacy/`** (`lib/gemini` = `legacy/lib/gemini`,
  `migrations/` = `legacy/migrations/`, `tests/` = `legacy/tests/`). v1 rules still apply to v1 code.
- **v1 commands run inside `legacy/`** (`cd legacy && npm run dev|test|…`, `npx tsx scripts/…`).
  `legacy/.env.local` holds the v1 env; an optional corporate CA goes in `legacy/certs/`
  (`legacy/instrumentation-node.ts` reads `<cwd>/certs/`). `ai-instruction/` is resolved from `legacy/` or the image root by
  `legacy/lib/paths/shared.ts`. v1 image: `docker build -f legacy/Dockerfile .` **from the repo root**
  (context must include `ai-instruction/ai-gen/`).
- **v2 commands:**
  - api: `cd app/api && uv sync && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest -q`
  - web: `cd app/web && npm ci && npm run typecheck && npm test && npm run build`
- **TDD for v2 (same rule as §10, different place):** pure logic first, tests before implementation.
  api → `app/api/tests/test_<topic>.py` (pytest, no network/DB unless it is an explicit integration test
  named `test_*_integration.py`); web → `app/web/src/**/<name>.test.ts(x)` (vitest). v1 tests stay in
  `legacy/tests/*.test.ts` + `legacy/package.json` `test` script.
- **CI is path-filtered:** `ci.yml` (legacy + v1 image build/health), `ci-api.yml`, `ci-web.yml`.
- v2 security rules are the v1 rules (§5–§7, §9b, §9f, §9m) re-stated per ARC spec; secrets stay server-only.

### 0.1 v2 database (ARC-02)

- **Neon** project `ricotdin-sg` (`dark-grass-92968821`, aws-ap-southeast-1, Postgres 18), org
  `org-wandering-night-27161653`. Branches: `main` (future staging/prod) and `dev` (development + tests).
  The old us-east-2 project `lucky-king-55263595` is unused. Local `app/api/.env` holds `DATABASE_URL`
  (dev branch, **direct** connection, never pooled for migrations/tests); never commit or print it.
- **Schema = Alembic** in `app/api/migrations/` (version table in schema `alembic`).
  `uv run --env-file .env alembic upgrade head`. New schema changes = new Alembic revisions, never
  edits to `0001`.
- **`0001_baseline.sql` is GENERATED**: `uv run --env-file .env python -m scripts.gen_baseline`
  replays `legacy/schema.sql` + `legacy/migrations/*` with a Supabase shim, introspects and renders
  (`app/db/{replay,introspect,baseline,ddl,v1_rewrite}.py`). Hand-written parts live in
  `migrations/src/` (prelude: roles, request context, `users`/`refresh_tokens`/`email_tokens`;
  epilogue; `overrides/` for v1 functions that cannot be rewritten). Edit those, regenerate, commit.
  `tests/test_schema_parity_integration.py` fails if the file is stale or v2 drifts from v1 beyond
  `app/db/parity.py` `ALLOWED`.
- **Roles** (both NOLOGIN, NOBYPASSRLS): `ricotdin_app` (API requests; RLS applies) and
  `ricotdin_service` (worker/admin/auth; permissive `service_all` policy on every RLS table).
  `anon` does not exist in v2. `users`, `refresh_tokens`, `email_tokens`, `admin_config`,
  `storage_config` are not readable by `ricotdin_app`.
- **App privileges are narrower than v1** (`app/db/grants.py`): v1 `authenticated` grants minus
  TRUNCATE/TRIGGER/REFERENCES/MAINTAIN (RLS does not govern them), and INSERT/UPDATE/DELETE only
  where a policy for that command exists. All meeting content is SELECT-only for the app, so
  **editor-level writes are enforced in the API** (`can_access_meeting(..., 'editor')`) and executed
  as `ricotdin_service`. PUBLIC has no TEMP on the database and no CREATE in `public`; functions
  later created by the migrating role are not PUBLIC-executable by default (tested). v1 policies without `TO`
  are scoped `TO ricotdin_app`. SECURITY DEFINER functions use `search_path = public, pg_temp`.
- **RLS request context** replaces the Supabase JWT: `app_user_id()` / `app_user_role()` read
  `current_setting('app.user_id' | 'app.role')`. These are plain GUCs any session can set, so RLS
  stops API logic bugs, **not** SQL injection or a leaked app credential (same trust model as v1's
  `request.jwt.claims`). ARC-04 requirements (security review of PR #33):
  R1 separate login credentials: the API login is a member of `ricotdin_app` only and runs
  requests as `ricotdin_app` (`SET ROLE`, or a NOINHERIT login) — `prevent_role_escalation` checks
  `current_user = 'ricotdin_app'`; worker/auth/admin use a different credential for
  `ricotdin_service`; no login is a member of both. Splitting `ricotdin_service` (worker vs
  auth/admin; append-only `audit_logs`/`quota_ledger`) is an ARC-04 acceptance criterion.
  R2 never serve requests as the table owner (owner bypasses RLS; no FORCE RLS) — assert at startup.
  R3 set the context per transaction only: `set_config('app.user_id', $1, true)` + `app.role` inside
  an explicit transaction (Neon pooler = PgBouncer transaction mode; session SET would leak).
  R4 bind parameters, never string-built `SET`. R5 values only from the verified token (`sub`) and
  `users.role`; whitelist role `user|admin`; set both or neither. R6 reset/roll back connections on
  check-in; test that a reused connection has no context. R7 statement/lock timeouts and connection
  limits per role. R8 no CREATE/TEMP for the app role (done in the schema).
- **Role source of truth:** `users.role`; trigger `sync_profile_role` mirrors it to `profiles.role`.
  `prevent_role_escalation` (v2 override, SECURITY INVOKER) decides by **invoking role**: only
  `ricotdin_app` is restricted (admin request context required); service/owner/definer callers pass.
- **Downgrade of `0001` drops `public`** and is refused outside `ricotdin_test_*` databases unless
  `RICOTDIN_ALLOW_DESTRUCTIVE_DOWNGRADE=1` (`app/db/safety.py`). Stale scratch databases are dropped
  only at pytest session start or by the generator CLI (exact `ricotdin_test_` prefix).
- **Known v1 bug carried over unchanged:** policy `folders_select` compares `fs.folder_id = fs.id`, so
  share grantees never see the shared `folders` row (meetings in it are visible). Do not build on
  grantees reading `folders`; fix via `/fix-bug`.

### 0.2 v2 API runtime (ARC-04)

- **Factory** `app/main.py` `create_app(settings)`, served with `uvicorn app.main:create_app --factory`
  (importing the module has no side effects). JSON logs with redaction for our logger **and**
  uvicorn / SQLAlchemy / asyncpg (`app/core/logging.py`, `redact.py`; access logs drop query strings);
  Sentry only if `SENTRY_DSN` (no bodies, no frame locals, no cookies/auth/query strings); pure-ASGI
  middleware CORS → security headers (CSP `default-src 'none'`, `no-store`, ...) → catch-all 500, so
  crashes keep both and are never re-raised; CORS exact-origin `ALLOWED_ORIGINS` (https only, http
  only for localhost); `/docs`, `/redoc`, `/openapi.json` only with `API_DOCS=1`; typed errors
  (`app/core/errors.py`, incl. `ServiceUnavailable` 503) → `{"error": {code, message}}` with detail
  only in logs. `GET /health` (no DB) and `GET /version.json`
  (`RICOTDIN_VERSION` → `BUILD_COMMIT` → `"unknown"`). Background hooks: `BACKGROUND_HOOKS` (ARC-08).
- **DB roles after migration 0002:** `ricotdin_app` (requests), `ricotdin_service` (auth + admin),
  `ricotdin_worker` (pipeline/schedulers; since migration 0005 an **explicit per-table allow-list**,
  §0.7 — no `users`/tokens, folders, shares, chat, features, `storage_config`, `quota_ledger`).
  `audit_logs`, `activity_log`, `quota_ledger` are append-only for all three; service roles have no
  TRUNCATE/TRIGGER/REFERENCES/MAINTAIN. Future migrations must GRANT to these roles explicitly.
- **Logins** `ricotdin_api_login` / `ricotdin_service_login` / `ricotdin_worker_login` (one group each,
  granted `WITH INHERIT FALSE, SET TRUE`, statement/lock/idle-in-transaction timeouts, connection
  limits 20/10/5; rotation terminates old sessions) are created/rotated by
  `uv run --env-file .env python -m scripts.provision_db_roles` (needs the owner `DATABASE_URL`), which
  writes `DATABASE_URL_APP` / `_SERVICE` / `_WORKER` into `app/api/.env` (atomic, 0600). Never in a
  migration. Neon accepts only plaintext passwords in CREATE/ALTER ROLE — never turn on statement
  logging for that; re-run to rotate if a log may have captured one.
- **`app/db/session.py` `Database`:** one asyncpg engine per configured login (pool below the role's
  connection limit, `hide_parameters=True`, `RESET ROLE; RESET ALL` + commit on every return to the
  pool); startup refuses a login that is superuser/BYPASSRLS/CREATEROLE/owner, inherits any role, or
  can `SET ROLE` (transitively, `pg_has_role`) to anything but its group, or whose group itself
  inherits another role (`StartupRefused`). Unhandled errors are reported to Sentry by the catch-all. Requests use
  `db.app_transaction(RequestIdentity)`; service/worker code uses `db.role_transaction(group)`.
  `RequestIdentity` comes only from the verified token (ARC-05); `get_database(request)` is the
  FastAPI dependency. Never `commit()` inside `app_transaction` (a new transaction has no context).
- **Accepted:** deleting a user cascades to their `activity_log` / `quota_ledger` rows (FK actions
  run as the owner; `audit_logs` uses SET NULL). Rate limiter (`app/core/ratelimit.py`) is
  in-process; pass `time.monotonic()`.
- **Image** `app/api/Dockerfile` (python 3.12-slim + ffmpeg, uid 10001, HEALTHCHECK `/health`); CI builds
  it and uploads `openapi.json` as an artifact (`python -m scripts.dump_openapi`). Behind a proxy set
  `FORWARDED_ALLOW_IPS` to the proxy subnet and keep port 8000 internal. Local:
  `uv run --env-file .env uvicorn app.main:create_app --factory --reload`. A container gets a
  runtime-only env file (`DATABASE_URL_*`, `JWT_PRIVATE_KEY`, `SMTP_*`, `MAIL_FROM`, `WEB_ORIGIN`,
  `ALLOWED_ORIGINS`, `SENTRY_DSN` - never the owner `DATABASE_URL`, so never `app/api/.env`).

### 0.3 v2 auth (ARC-05)

- **Endpoints** (`app/routers/auth.py`, `profile.py`): `POST /auth/register|login|refresh|logout|
  verify-email|resend-verification|forgot-password|reset-password`, `GET /auth/me`,
  `POST /profile/change-password`, `GET /.well-known/jwks.json`. All auth SQL runs as
  `ricotdin_service` (`app/auth/service.py`); routes use `current_identity` / `require_admin`
  (`app/auth/deps.py`) -> `RequestIdentity` -> `db.app_transaction`.
- **Rules kept from v1 (§9b):** register forces role `user` (role changes only through admin code
  writing `users.role`; a trigger mirrors `profiles.role`); username -> email lookup server-side;
  unknown identifier and wrong password give the same 401 (`invalid_credentials`, dummy argon2
  verify); `email_not_verified` / `account_disabled` (403) only after a correct password;
  duplicate email/username at register -> 409 (owner decision 2026-10-26).
- **Passwords:** argon2id (`app/auth/passwords.py`); Supabase bcrypt hashes verify once and are
  rehashed (compare-and-set under a row lock, so a concurrent reset wins). Hashing runs in worker
  threads, at most 4 at a time (`AuthRuntime.run_hash`).
- **Access token:** EdDSA JWT, 15 min, claims `sub`, `role`, `typ=access`, `iss=ricotdin-api`,
  `aud=ricotdin-web`; only EdDSA accepted; verify key chosen by `kid` (current or
  `JWT_PREVIOUS_PUBLIC_KEY`). Role / disable changes apply at the next refresh (<= 15 min, owner
  decision). The SPA keeps it in memory and retries once via `/auth/refresh` on a 401.
- **Refresh token:** opaque, only sha-256 stored, rotated on every use, cookie
  `__Secure-ricotdin_rt` (HttpOnly, Secure, SameSite=Lax, host-only, `Path=/auth`, 30 days,
  `REFRESH_TTL_DAYS`). Web and API are sibling subdomains of one site (owner decision); login,
  refresh and logout require `Origin` in `ALLOWED_ORIGINS` + `WEB_ORIGIN`. A rotated token
  presented more than 10 s later revokes its whole family (theft); within 10 s it is a race
  (second tab, retry): 401 without revoking. Disabled user -> 401 + all tokens revoked. Reset and
  change-password revoke every session (change-password then starts a new one). The API must be
  served at `/` (cookie path).
- **Email tokens** (`email_tokens`): single use, hashed, verify 24 h, reset 1 h; a new one voids
  the previous; links are `WEB_ORIGIN/verify-email#token=...` and `/reset-password#token=...`
  (fragment: never in server logs). forgot-password / resend-verification always answer 202 and
  send in the background. Emails are bilingual EN + VI (`app/email/templates.py`); SMTP implicit
  TLS on 465, STARTTLS otherwise; the recipient is passed explicitly; addresses must be one plain
  `local@domain`.
- **Rate limits** (in-process, `Limiters` in `app/auth/runtime.py`): login per client (IPv6 by
  /64) 10/15 min, per account + client 10/15 min, per account 100/h; register 5/h per client;
  email sends 5/15 min per client and 3/h per address; verify/reset 20/15 min per client;
  change-password 5/15 min per user.
- **Env (server only):** `JWT_PRIVATE_KEY` (Ed25519 PKCS#8 PEM on one line with escaped newlines;
  `uv run python -m scripts.gen_jwt_key` creates it, `--rotate` replaces it and moves the old
  public key to `JWT_PREVIOUS_PUBLIC_KEY`, delete that line after 16 min; rotate yearly and at once
  on suspected exposure, then also revoke all refresh tokens since a leaked key mints admin
  tokens), `WEB_ORIGIN` (required with the key: links + CORS), `SMTP_HOST|PORT|USER|PASSWORD`,
  `MAIL_FROM` (Gmail app password; revoke old ones at Google, deleting from `.env` is not enough),
  optional `REFRESH_TTL_DAYS`. Without `JWT_PRIVATE_KEY` auth routes answer 503; without `SMTP_HOST`
  no mail is sent (`email_sent: false`). On Windows `chmod 0600` does nothing: restrict
  `app/api/.env` with `icacls app\api\.env /inheritance:r /grant:r "%USERNAME%:F"`.
- **Open (owner decision pending):** an unverified account blocks re-registration of its email
  (409), so someone could pre-register a victim's address with their own password and hope the
  victim clicks the verify link. Refresh sessions have no absolute lifetime (sliding 30 days).

- **Integration tests** (`*_integration.py`) create and drop `ricotdin_test_*` databases on the
  `DATABASE_URL` branch (never point it at `main`); CI runs them against a `pgvector/pgvector:pg18` service.

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

### 0.5 v1 → v2 data migration (ARC-03)

- `app/api/scripts/migrate_from_supabase.py` is an owner-run CLI; the pure logic lives in
  `app/migration/`. Runbook and rehearsal log: `docs/ops/v2-migration-rehearsal.md`.
- Env lives only in the git-ignored `app/api/.env.migrate`:
  - `SUPABASE_DB_URL` (session pooler), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`;
  - `MIGRATION_TARGET_DATABASE_URL`, an owner URL; never `DATABASE_URL`;
  - `KEY_ENCRYPTION_SECRET`.
  None of these is an app runtime variable.
- **Run** with `--confirm-target <host>` plus either `--r2-bucket <bucket>` or `--skip-storage`.
  Rehearsals copy audio into a separate `ricotdin-rehearsal` bucket, never into production.
- **Source:** one `REPEATABLE READ READ ONLY` snapshot; Supabase is never written.
- **Target:**
  - Upsert by primary key, in foreign-key order, one transaction per table, with user triggers
    off so `updated_at` values are kept.
  - Values travel as text: `col::text` → `%s::text::<type>`.
  - Session output settings are pinned on both sides.
  - `profiles.role` is taken from `users.role`.
  - The script reads the schema from the catalog, so a future migration needs no code change
    unless it renames or retypes a column. The preflight then blocks on the drift.
  - **A migration that creates a v2-only table** (no Supabase counterpart) must add it to
    `V2_ONLY_TABLES` in the script, or every run is blocked (BUG-020);
    `test_bug020_every_table_created_after_the_baseline_is_v2_only` enforces it.
- **Report:**
  - Order-independent digests per table, plus secrets and storage results.
  - PASS needs a full run (storage not skipped).
  - Database errors appear only as class and SQLSTATE. Never print psycopg messages: their
    DETAIL quotes row values.
  - Report files (`migration-report*.md`) are git-ignored.
- **The final run (ARC-15)** must happen after v1 writes stop and **before** v2 accepts logins,
  because a re-run overwrites `users.*`.

### 0.6 v2 core domain API (ARC-07)

- **Routers** `meetings.py`, `content.py` (todos, calendar, `.ics`), `folders.py` (folders, shares,
  reorder, `/users/lookup`), `profile.py`, `activity.py`. `regenerate` is ARC-08. Paths have no
  `/api` prefix (`v2-tracking.md`).
- **Files (part 2, Google Drive, §0.4):** `POST /meetings` creates the pending row
  (`storage_provider='gdrive'`, migration `0004`; title `Nov 2, 2026, 3:05 PM` in
  `Asia/Ho_Chi_Minh`) and a resumable upload URL in one transaction (Drive failure → no row); the
  body must carry `size`. `POST /meetings/{id}/uploaded` (owner, only while `pending`, else 409)
  takes `fileId` + `size`, verifies with `confirm_upload`, queues **one** job (no second while one is
  queued/running); a mismatching file deletes the meeting (v1 `rejectUpload`) → 422. ffprobe and
  video → audio extraction are the ARC-08 worker's. `GET /meetings/{id}/audio-url` (viewer+) →
  `{url: "/media?t=…" (15 min), hackAudioRender}`. Deletes (`DELETE /meetings/{id}`,
  `DELETE /folders/{id}?deleteMeetings=true` = caller's own meetings only, BUG-011) remove the Drive
  file first, each in its own committed step (`delete_files`), then the rows; a storage failure →
  `warning` (meeting delete) and the rows still go. Avatar: `POST /profile/avatar` → upload URL +
  key; `PATCH /profile {avatar_key, avatar_file_id, avatar_size}` confirms the file before saving,
  deletes the old avatar after (only if it is this user's key); `avatar_url` = `/media` link.
  Upload sessions (meetings + avatars): 30 per user per hour (`app.state.upload_limiter`); at most
  20 `pending` meetings per user (429). `/uploaded`: a mapped key + another file id → 409 (the
  meeting is never deleted); a missing file → 422 and the meeting stays (v1); only a rejected file
  that was this meeting's own session upload deletes the meeting. Deletes run a second Drive pass
  after the row delete (an upload confirmed in between). Known, accepted for now: Drive HTTP calls
  run inside the service transaction (holds a connection and the row lock, ≤ ~2 min with retries);
  the avatar map is committed before the profile UPDATE (a failed UPDATE leaves an unreferenced
  2 MB file); deleting a v1 (`r2`/`supabase`) meeting is a Drive no-op until ARC-18 copies files.
- **Move = meeting owner only** (owner decision 2026-11-02, CWE-269): `PATCH /meetings/{id}` with
  `folder_id` from anyone else → 403 "Only the meeting owner can move it to another folder.";
  editors still rename.
- **Status codes = v1** for owner / folder owner / editor / viewer / stranger (matrix test:
  `tests/test_core_domain_integration.py`). Messages keep v1's text inside `{"error": {code, message}}`.
  Where v1 crashed (500 on `null` bodies, non-UUID ids, `folder_id: ""`) v2 answers 400/404/422.
  Kept on purpose: stranger → 403 on meeting writes but 404 on reads and on folder PATCH/DELETE;
  share PATCH/DELETE answer 200 for a non-member; reorder always 200.
- **One active job per meeting** (ARC-08, migration 0005): unique index
  `jobs_one_active_per_meeting` on `jobs(meeting_id) WHERE status IN ('queued','running')`;
  `process` and `uploaded` insert with `ON CONFLICT ... DO NOTHING` (a repeat while one is active
  queues nothing; `process` still answers 202). `POST /meetings/{id}/process`: 30 per user per hour
  (`app.state.process_limiter`, 429); 409 "This meeting is still being uploaded." while the meeting
  is `pending` and its file is not mapped yet (`/uploaded` queues the job).
- **Who runs what:** meeting reads (`GET /meetings*`) run as `ricotdin_app` under RLS. Meeting /
  todo / calendar writes run as `ricotdin_service`, with the role decided **in the same transaction**
  by `app/services/access.py` + pure `app/domain/access.py` (same logic as `can_access_meeting`;
  admins get no extra access). Folders, shares and lookup run as service with checks in code (v1 did
  the same; avoids the `folders_select` bug, §0.1). `PATCH /profile` and preferences write as
  `ricotdin_app` (column grant + `profiles_update`), so `role` can never be written.
- **Validation** is pure in `app/domain/rules.py`; `.ics` in `app/domain/ics.py`; the model
  allow-list in `app/domain/models.py` (from `app_settings['generation.allowed_models']`, fallback
  gemini only). Bodies are read with `routers/_common.json_object` (bad JSON / non-object → 400).
- `POST /activity`: 10 per user per minute (in-process, `app.state.activity_limiter`); the insert is
  best effort and `meetingId` is stored only for a meeting the caller can see (else NULL).
- Email → account lookups (`POST /users/lookup`, adding a share): 20 per user per 15 min
  (`app.state.lookup_limiter`): v2 searches every user, v1 only the first page.
- Differences from v1 to know: `PATCH /profile` validates every field before the username-taken
  check (v1 checked taken first). Transcript `confidence` is returned as a number. Playback links live
  15 min (v1 60) because `/media` proxies Drive.

### 0.7 v2 worker (ARC-08; slices 08a foundation, 08b transcription)

- **Process:** `python -m app.worker` (`app/worker/`), same image as the API, **its own container
  with only `DATABASE_URL_WORKER`** (+ `KEY_ENCRYPTION_SECRET`, `LOG_LEVEL`, `SENTRY_DSN`). It refuses
  to start (exit 2) if `DATABASE_URL`, `DATABASE_URL_APP`, `DATABASE_URL_SERVICE`, `JWT_PRIVATE_KEY`,
  `SMTP_PASSWORD` or a Supabase / migration credential is set (`policy.worker_env_problems`), and
  **while pipeline steps are missing**: `analyse` / `embed` come with 08c–08d, so the worker is
  **not deployable before then** (no deploy target yet; tests drive `JobRunner` directly).
  Deployment (ARC-15 / OPS-05): `stop_grace_period: 30s` for the worker service.
- **Runner** (`runner.py`, port of v1 `lib/jobs/worker.ts`): `claim_next_job` (`SKIP LOCKED`), one
  job at a time, poll 1 s, stuck sweep every 60 s (running > 15 min). Each step runs in a private
  temp dir `ricotdin-job-*` (removed after; leftovers older than 1 h are removed at startup) with a
  12 min timeout (< the 15 min stuck threshold). Every job write — also the step's own payload write
  — is guarded by `status='running' AND locked_by=<worker id>` (a job the sweeper took back is never
  overwritten; `start` then rolls back its reserve: `JobLockLost`). Steps return
  `Advance(step, payload, delay)` / `Done(payload, activity)` / `Fail(message, metadata)`; unknown
  step → terminal. SIGTERM: stop claiming; after 8 s (below docker's default 10 s) a running step is
  cancelled and its job released (queued at once, attempts unchanged). Loop errors (database down)
  back off 1 → 30 s and reach Sentry at most once a minute.
- **Errors** (`errors.py`): `PipelineError(message, detail=)` = terminal, never retried (bad or
  unreadable file — also an ffprobe timeout —, forged key, audio > 6 h, unknown step / provider /
  model, provider rejection); typed `AppError` 4xx terminal, 503/429 transient; anything else
  transient. Transient → queued with backoff 2 s·2ⁿ⁻¹ ≤ 5 min ±25 %, until `max_attempts`.
  Terminal / exhausted / stuck-exhausted / **deadline** (6 h from `payload.started_at`, bounds
  re-queued polling, 08b) → job failed, **refund** (`pipeline_refund`), meeting failed (never a
  `done` meeting), activity `processing_failed` (owner decision 2026-11-02: the stuck sweep refunds
  too; v1 did not).
- **Messages** (`messages.py`): `meetings.error_message` and activity metadata get only text written
  for users (`user_message`: a `PipelineError` message, an `AppError` public message, the
  `QUOTA_BLOCKED: …` text, else "Processing failed. Please try again or contact an
  administrator."). The full redacted detail (stderr, driver errors) goes only to `jobs.last_error`
  (admin) and the logs (`error_text`).
- **Quota** (`quota.py` + SQL wrappers of migration 0005): dedup keys are **per job** —
  `gen:<job_id>:reserve|settle|refund` (owner decision 2026-11-02; v1 used the meeting id, so a
  requeue/reprocess was never charged again). Each process/requeue inserts a new job, so each run is
  charged once; retries of a job stay idempotent. The worker **cannot call `quota_apply_movement`**;
  it has three SECURITY DEFINER wrappers: `pipeline_reserve(job, seconds)` (1–86400 s, running job
  only, user = the job's meeting owner), `pipeline_refund(job)` (exactly the reserve ledger row's
  amount, once; nothing without a job-keyed reserve or after a settle — so migrated v1 jobs never get
  a free refund), `pipeline_settle(job, actual)` (08b: reserved − actual, 0–86400 s, not after a
  refund). Amounts never come from `jobs.payload`. Each wrapper first takes a per-job advisory
  transaction lock; refund needs a `failed` job (the runner fails the job first, same transaction),
  reserve and settle a `running` one — so a refund and a settle never both apply. The reserve and the payload's `reserve_done`
  (true stays true) are written in one transaction. v1 `lib/quota/reconcile.ts` still looks up
  meeting-keyed dedup keys: port it with job keys (08e).
- **Step `start`** (`start.py`): claim meeting `pending|failed → processing` (a `processing` meeting
  is a restart), `owned_audio_path` (forged → terminal), `storage_provider` must be `gdrive`,
  model-lock hook (`lock_generation_model`, no-op until 08c), download (map lookup in a short
  transaction, streaming outside it), ffprobe (audio-only; `source='video'`: video mode + `-vn` mp3
  extraction, moved here from `/uploaded`), estimate = ceil(ffprobe) or `duration_seconds` (> 6 h →
  terminal), reserve (insufficient → `QUOTA_BLOCKED: …`, no retry), transcode mono 16 kHz 64 kbps
  mp3 (failure keeps the original), `Transcriber.submit` (language auto-detect, v1) →
  `transcribe_poll` after 5 s. The extracted audio of a video is not stored: `/media` still serves
  the original video.
- **Transcription (08b)** — `speechmatics.py` (pure json-v2 parse, untrusted: types, finite numbers,
  bounded labels/language), `speechmatics_client.py` (`SpeechmaticsTranscriber`, created once in
  `__main__`), step `transcribe_poll.py`; registry `steps.py`.
  - One key per provider job: `payload.transcriber_key_ref` = `id:<admin_config id>` or
    `env:<sha256[:16]>` (never the key). New jobs take the key with the fewest jobs in flight in
    this process (counts kept per ref, survive key reloads). 401 → `KeySource.mark_invalid`
    (submit retried with another key; a poll whose key is gone is terminal). 429/5xx/network →
    8 tries, 0.6 → 10 s, then transient. Other 4xx → terminal "could not process". Transcript
    ≤ 64 MiB, status ≤ 1 MiB; job ids `[A-Za-z0-9_-]{1,64}` (URL path).
  - Poll: `running` → again in 5 s (no attempt); `done` → no speech = terminal + full refund
    (spec; v1 job path marked done); else ONE transaction guarded by `locked_by`:
    `transcription_settled` in the payload, `pipeline_settle(job, ceil(seconds))`, replace
    segments (and old chunks), `meetings.language`, `usage_log` (`audio_seconds`, `key_id` only if
    the admin key still exists) → `analyse`. A re-run with `transcription_settled` skips to
    `analyse`. Language-detect rejection (first time) → re-download, transcode, resubmit `en`.
- **ARC-15 ordering:** jobs of v1 meetings (`storage_provider` `r2`/`supabase`) fail terminally in
  `start` until ARC-18 has copied their files to Drive — run the ARC-18 copy before starting the
  worker (or keep the worker stopped until then).
- **ffmpeg/ffprobe on untrusted files** (`audio.py`): `-protocol_whitelist file`, `-format_whitelist`
  of our upload demuxers (an HLS/concat playlist disguised as audio is refused), stdin `/dev/null`,
  a minimal environment (`PATH`, `LANG`/`LC_ALL=C`: no database URL, no `KEY_ENCRYPTION_SECRET`),
  `-threads 2`, `-t 6h`, `-fs 1 GiB`, RLIMITs (2 GiB address space, file size, CPU, no core dumps),
  timeouts (probe 60 s, ffmpeg 8 min; the process group is killed). Gemini audio transcription and
  long-audio chunking are **not ported** (owner decision 2026-11-02: dead code in v1).
- **Worker grants (migration `0005_worker_grants`):** SELECT `meetings` + UPDATE of status,
  error_message, summary, notes, language, generation_provider/model, duration_seconds, audio_path,
  audio_purged_at; SELECT `jobs` + UPDATE of status, step, attempts, last_error, run_after, payload,
  locked_at, locked_by (no INSERT/DELETE); SELECT/INSERT/UPDATE/DELETE `transcript_segments`,
  `transcript_chunks`, `todos`, `calendar_suggestions`, `storage_objects`; SELECT `drive_config`,
  `admin_config` (+ UPDATE of health_* / last_used_at), `app_config`, `app_settings`,
  `quota_wallets`, `profiles(id, default_provider, default_model)`; INSERT only `usage_log`,
  `activity_log` (not `audit_logs`: 08e adds a SECURITY DEFINER function for the retention purge's
  audit row with a forced `system:` actor); explicit EXECUTE only `claim_next_job` and the three
  `pipeline_*` wrappers (functions PUBLIC-executable since v1 — `can_access_meeting`,
  `match_transcript_chunks`, triggers, extensions — stay so). `service_all` keeps the worker only on
  those tables. A worker feature needing more = a new migration +
  `tests/test_worker_grants_integration.py`. The `/media` lookup (worker) still works. Downgrade
  restores the 0004 privileges exactly (tested).
- **What a worker breach still exposes:** SELECT on all meeting content (transcripts, notes, chunks,
  to-dos) of every user, DELETE on `storage_objects` (and the Drive files through the token), the
  Drive refresh token (`drive_config` + `KEY_ENCRYPTION_SECRET`) and the decrypted provider keys.
  **ARC-15 follow-up:** run ffmpeg/ffprobe sandboxed — separate uid, no network, seccomp / read-only
  root (or a separate sidecar without database or key access).
- **Data migration (§0.5):** the ARC-03 preflight blocks when v1 has more than one queued/running job
  per meeting (the unique index would abort the copy) and prints the `UPDATE` that fails the extras
  in Supabase (keeps the newest).

## 1. What we are building

A **meeting assistant** web app (MVP). The user records a meeting in the
browser, the app produces a transcript + summary + meeting note, extracts
to-do items and calendar mentions, and offers a RAG chatbot to ask questions
about past meetings (NotebookLM-style).

**MVP scope (build this):**
1. In-browser recording (screen/tab + system audio + mic).
2. Upload audio → process → transcript with timestamps.
3. Meeting note + summary.
4. To-do extraction.
5. RAG chatbot over transcripts (with timestamp citations).
6. Surface calendar suggestions + to-dos in the UI (display only).

**Explicitly OUT of MVP scope (do NOT build yet):**
- Google Calendar OAuth / auto-creating events (MVP only offers `.ics` download).
- Proactive reminders / push notifications.
- Auto-detecting which meeting app is running / auto-starting recording.
- Multi-user collaboration features.
Do not add these without being asked, even if they seem natural.

## 2. Tech stack

- **Next.js (App Router) + TypeScript** — single codebase, frontend + API in one.
  Runs as a long-lived `next start` server on the user's own host (NOT serverless),
  so route handlers may run long tasks directly; no external queue needed for MVP.
- **Supabase** — Postgres (with pgvector), Storage (audio), Auth.
- **Google Gemini** via Google AI Studio API — Flash / Flash-Lite, free tier for MVP.
- Package manager: npm. Node 20+.

## 3. Architecture & data flow

```
Browser (recorder + UI)
  → upload audio to Supabase Storage via presigned URL (direct, not through server)
  → notify server route; create `meetings` row (status=pending)
  → server pipeline: download audio → Gemini Files API → Gemini Flash
      → returns JSON: transcript segments + summary + notes + todos + calendar mentions
  → write rows to Postgres; chunk transcript; embed chunks → transcript_chunks
  → status=done
UI reads results. Chat: embed question → match_transcript_chunks RPC → Gemini answer + citations.
```

## 4. Directory structure (target)

```
/app                      Next.js App Router (pages + route handlers)
  /api                    route handlers (server-only)
  /(routes)               UI pages (meeting list, meeting detail, chat)
/lib
  /gemini                 Gemini service layer (the ONLY place that calls Gemini)
  /supabase               typed Supabase client helpers (browser + server/service)
  /audio                  client-side recording + chunking helpers
/components               React components
/types                    shared TypeScript types (incl. DB row types)
schema.sql                database schema (apply as a migration)
CLAUDE.md                 this file
```

## 5. Conventions

- TypeScript strict mode. No `any` unless justified with a comment.
- Server-only code (anything touching the Gemini key or Supabase service role key)
  lives in `/app/api` route handlers or `/lib` modules imported only by the server.
  **The Gemini API key and the Supabase service role key must NEVER reach the browser.**
- Use the typed Supabase client; mirror DB types in `/types`.
- Errors: throw typed errors in `/lib`, catch + map to HTTP responses in routes.
  User-facing errors are friendly; full detail goes to logs and `meetings.error_message`.
- Naming: `camelCase` in TS, `snake_case` in SQL (matches the schema).
- Keep functions small and single-purpose. Prefer pure functions in `/lib`.

## 6. Database

Schema is in `schema.sql` (Postgres + pgvector). Key tables:
`meetings` (root), `transcript_segments` (canonical transcript), `transcript_chunks`
(embeddings for RAG), `todos`, `calendar_suggestions`, `chat_sessions`,
`chat_messages`. RAG retrieval is the `match_transcript_chunks` RPC.

**`meetings` additional columns (via migrations):**
- `pinned_at timestamptz NULL` (migration 004) — null = not pinned. Set to `now()` to pin.
  List sort: `pinned_at DESC NULLS LAST, created_at DESC` (pinned first, most-recently-pinned on top).
  Index: `meetings_user_pin_sort ON meetings (user_id, pinned_at DESC NULLS LAST, created_at DESC)`.

**Delete rule:** when deleting a meeting, the server route (`DELETE /api/meetings/:id`)
MUST attempt to remove `meetings.audio_path` from Supabase Storage (bucket `recordings`)
using the service-role client BEFORE deleting the row. Storage delete failure is logged
and surfaced as a `warning` field in the response, but the row delete always proceeds
(no half-state). All child rows are removed by `ON DELETE CASCADE` on the DB side
(transcript_segments, transcript_chunks, todos, calendar_suggestions, chat_sessions,
chat_messages).

Rules:
- RLS is ON. The browser uses the anon key (RLS-scoped to the logged-in user).
- The **server pipeline uses the service role key** (bypasses RLS) for background writes.
- `meetings`: the browser is SELECT-only (RLS-scoped). INSERT/UPDATE are revoked (migration 033, BUG-003) and
  DELETE/TRUNCATE too (migration 038, BUG-008) — every write/delete goes through a server route with the
  service-role client (delete must remove the audio first). Never add a browser or user-scoped write to `meetings`.
- `transcript_segments` / `transcript_chunks`: browser is SELECT-only (INSERT/UPDATE/DELETE revoked,
  migration 035, BUG-007) — only the pipeline (service role) writes transcript/RAG content. Never add a
  browser or user-scoped write to these tables.
- `todos`, `calendar_suggestions`, `chat_sessions`, `chat_messages`: browser is SELECT-only too (migration 036,
  BUG-009/010). Status/dismiss changes go through the PATCH routes; chat writes through `POST /api/chat`.
  Never add a browser or user-scoped write to these tables.
- Any server code that signs, downloads or deletes a storage key read from a DB row MUST check the key
  belongs to that row: `ownedAudioPath` / `isOwnedAudioKey` (meetings), `isOwnedAvatarKey` (profiles).
- Every `SECURITY DEFINER` function MUST `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated` and grant
  only the roles that need it. "No GRANT" does NOT mean "not callable": Postgres grants EXECUTE to
  PUBLIC by default (BUG-005, migration 034). Exceptions: trigger functions (not callable via PostgREST)
  and `can_access_meeting`, which RLS policies call as `authenticated` and which only answers for
  `auth.uid()` (it keeps EXECUTE; see BUG-005).
- Embedding dimension is **768** and must match the `output_dimensionality` we
  request from Gemini's embedding model. Do not change one without the other.

## 7. Gemini integration rules

- All Gemini calls go through `/lib/gemini` — a single service layer. Nothing else
  imports the Gemini SDK directly. This lets us switch free↔paid with zero changes
  elsewhere.
- Use **JSON mode** with a fixed response schema for the pipeline output, and parse
  defensively (strip code fences, validate before using).
- **Retry with exponential backoff on HTTP 429** (free tier hits rate limits often).
- **Chunk long audio** into ~20–30 minute segments before sending, to stay under
  the per-minute token limit; stitch transcripts back together by time offset.
- Default model: `gemini-2.5-flash` for the pipeline (quality), `gemini-2.5-flash-lite`
  is acceptable for cheap/iterative dev runs. Make the model name a config constant.
- Upload audio via the Gemini **Files API** (temporary staging, ~48h retention) and
  reference it in the prompt; do not inline large audio as base64.
- **Free-tier privacy note:** on the free tier, inputs may be used by Google for
  training. **Owner decision (2026-10-23):** all models keep using the current keys regardless
  of tier and provider data use is accepted for internal use — do not block or warn on this
  (PRV-01 parked, see `ai-instruction/roadmap.md`). Revisit before outside users or commercialisation.

## 8. Environment variables

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=        # server only, NEVER exposed to client
GEMINI_API_KEY=                   # server only, NEVER exposed to client (env fallback)
KEY_ENCRYPTION_SECRET=            # 64 hex chars (32 bytes). Generate:
                                  # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
                                  # NEVER log. Losing it makes all stored DB keys unrecoverable.
```
Anything not prefixed `NEXT_PUBLIC_` is server-only. Never log secret values.

CI-only GitHub secrets for the DB backup workflow (OPS-03, never app env vars): `SUPABASE_DB_URL`
(Session pooler; environment secrets of the `backup` environment), `AGE_RECIPIENT` (age public key), `R2_BACKUP_ACCOUNT_ID`, `R2_BACKUP_ACCESS_KEY_ID`,
`R2_BACKUP_SECRET_ACCESS_KEY`, `R2_BACKUP_BUCKET`. See `docs/ops/backup-restore.md`.

## 9. Commands

v1 — run inside `legacy/` (ARC-00). v2 commands: §0.

```
npm run dev        # local development
npm run build      # production build
npm run start      # run the production server (deployment target)
npm run lint       # ESLint
npm run check      # connectivity check: Gemini + Supabase (reads .env.local)
npm run verify:deploy -- https://<host> --expect vX.Y.Z   # post-deploy check: /version.json + /api/health (OPS-07)
npm run test       # run tests (not yet configured)
```

## 9k. Release process

**Branches** (GitHub default branch = `dev`, so fresh clones land on `dev`, a bare
`gh pr create` targets `dev`, and `schedule` workflows run from `dev` — always pass `--base` explicitly):
- `dev` — day-to-day work; every push → Docker image `ricotdin:dev` (`release-dev.yml`).
- `main` — stable integration branch; only receives PRs from `dev` (and hotfix merge-backs).
- `release/X.Y` — one branch per minor version line, cut from `main`. Receives **bugfixes
  only**, never new features. All `vX.Y.Z` tags live here (`v1.0.0`, `v1.0.1`… on `release/1.0`).
- `ci.yml` runs on push/PR to `main`, `dev` and `release/**` (on `dev` informational only — not a required check; OPS-06).

**Versioning:** SemVer. `package.json` `version` MUST equal the tag without the `v` — since ARC-00 that
file is **`legacy/package.json`** (run `npm version` inside `legacy/`).
`release.yml` rejects a tag that does not match `legacy/package.json` or whose commit is not on
`release/X.Y` (the branch matching the tag's major.minor).

**New minor/major release `X.Y.0`:**
1. On `dev`: `npm run lint && npm run typecheck && npm run test && npm run build`.
2. `npm version X.Y.0 --no-git-tag-version`; add a `## [X.Y.0]` section to `CHANGELOG.md`
   (features + deploy checklist: new migrations, new env vars, dashboard steps + known issues).
3. Commit `chore(release): vX.Y.0`, PR `dev` → `main` (`gh pr create --base main --head dev`), merge (merge commit, not squash) after CI is green.
4. Cut the branch: `git checkout main && git pull && git checkout -b release/X.Y && git push -u origin release/X.Y`.
5. Tag on it: `git tag -a vX.Y.0 -m "Release vX.Y.0" && git push origin vX.Y.0`
   → `release.yml` pushes `mingming21400/ricotdin:vX.Y.0` (+ `:latest` if highest) and opens
   PR `ricotdin vX.Y.0` on `mmlabs-online/deployment` (OPS-04, see Deploy below).
6. Create the GitHub Release from the `CHANGELOG.md` section.

**Hotfix `X.Y.(Z+1)` for an existing line:**
1. Branch from `release/X.Y` (e.g. `hotfix/<topic>`), fix + test, bump version, add CHANGELOG entry.
2. PR into `release/X.Y`; after merge, tag `vX.Y.(Z+1)` on `release/X.Y` and push the tag.
3. Merge `release/X.Y` back into `main` and `dev` so the fix is not lost in the next release.
   `ricotdin:latest` only moves when the pushed tag is the highest version, so a hotfix on
   an old line never drags `latest` backwards.
   **After ARC-00:** `release/1.1` (and tags ≤ v1.1.1) still has v1 at the repo root, while `dev`/`main`
   have it in `legacy/`. Merging back relies on git rename detection: edits to moved files follow them,
   but a file **added** on `release/1.1` (new test, new migration) may land at the root or raise a
   directory-rename conflict — after the merge, check every new file sits under `legacy/` and that
   `legacy/package.json` has the hotfix version.

**Step-by-step for the owner:** `docs/ops/release-runbook.md` (OPS-07) — one-time hand deploy +
per-release order (migrations → deploy → `npm run verify:deploy`).

**Deploy = merge the deployment PR (OPS-04):** image `mingming21400/ricotdin`, tags are
v-prefixed (`vX.Y.Z`). After `verify` passes, `release.yml` builds + pushes the image, then
(secret `DEPLOY_REPO_TOKEN` — fine-grained PAT on `mmlabs-online/deployment` only, Contents +
Pull requests RW) opens PR `ricotdin vX.Y.Z` on `mmlabs-online/deployment` that writes ONLY
`apps/ricotdin/release.env`:
`RICOTDIN_IMAGE=mingming21400/ricotdin:vX.Y.Z@<digest>` (pinned by digest) + `RICOTDIN_VERSION=vX.Y.Z`.
Reviewing + merging that PR deploys to the home server (deployment-repo side = OPS-05: drafts in
`docs/ops/deployment-repo/` — `apps/ricotdin/compose.yml`, `deploy-ricotdin.yml`, README with the
verification prompt; runtime secrets ONLY in the server file `/etc/mmlabs/ricotdin.env`, never in a repo).
The tag is never baked into the image; runtime `RICOTDIN_VERSION` (non-secret) is served by
public `GET /version.json` (fallback: baked `BUILD_COMMIT`, then `"unknown"` —
`lib/release/version.ts`). Public `GET /api/health` → `{"status":"ok"}` (no DB/provider calls)
backs the image `HEALTHCHECK`. Never deploy `dev` or `latest`. Apply that release's new
migrations BEFORE merging the deployment PR. Rollback = a deployment PR pinning the previous
release's digest (only safe if no destructive migration ran in between).

## 9l. Traceability (feature / bug ↔ branch ↔ commit ↔ PR)

Tickets live **in the repo only** — no GitHub Issues. Features: `ai-instruction/tracking.md`
(`ABC-12`). Bugs: `ai-instruction/bugs.md` (`BUG-NNN`). Linking is by convention (no CI check);
the `/add-feature`, `/ship-feature` and `/fix-bug` skills apply it automatically.

| Artifact | Convention |
|---|---|
| Branch | `feat/<CODE>-<slug>` · `fix/BUG-NNN-<slug>` (from `dev`) · `hotfix/BUG-NNN-<slug>` (from `release/X.Y`) · `docs/<CODE>-<slug>` |
| Commit | Conventional Commits with the code at the end: `feat(rag): folder export (RAG-05)`, `fix(quota): no double charge (BUG-004)` |
| PR title | `[<CODE>] <summary>`; body from `.github/pull_request_template.md` |
| Release PR | `chore(release): vX.Y.Z`; body lists every code included (command below) |
| CHANGELOG | each bullet ends with its code(s): `- … (PRO-09)` |
| Back-link | after a PR is opened, add `PR #N` to the Note cell in `tracking.md` / the Link cell in `bugs.md` |

Look-ups:
```
git log --oneline --grep 'PRO-09'                         # commits for a code
gh pr list --state all --search 'PRO-09 in:title'          # PRs for a code
git log main..dev --format=%s | grep -oE '\b[A-Z]+-[0-9]+\b' | sort -u   # codes in the next release
```

## 9a. Manual Supabase dashboard actions required

Before Phase 2 features work end-to-end, you must do the following once in the
Supabase dashboard:

1. **Create a private Storage bucket named `recordings`**
   - Dashboard → Storage → New bucket → Name: `recordings` → uncheck "Public bucket" → Save
   - The server route checks for this bucket on every upload and returns 503 with a
     clear message if it is missing.

2. ~~**Enable Anonymous sign-ins**~~ **Phase 7 complete — disable this now.**
   - Dashboard → Authentication → Providers → Anonymous sign-ins → **Disable**
   - Real email+password auth is in place. Existing anonymous-user test data is
     orphaned — wipe it with `DELETE FROM auth.users WHERE is_anonymous = true`.

3. **Apply Phase 7 migrations** (run in the SQL editor in order):
   - `migrations/001_profiles.sql` — profiles table + RLS + role-escalation trigger
   - `migrations/002_jwt_hook.sql` — custom access token hook function
   - `migrations/003_rls_owner_or_admin.sql` — owner-or-admin RLS on all tables
   - Then: Dashboard → Authentication → Hooks → Custom Access Token →
     select `public.custom_access_token_hook` and save.

4. **Apply Phase 8 migration:**
   - `migrations/004_meetings_pinned.sql` — adds `pinned_at` column + sort index to `meetings`.

5. **Apply Phase 13 migration:**
   - `migrations/014_provider_keys.sql` — provider_keys table (AES-256-GCM encrypted key pool).
   - Before running: set `KEY_ENCRYPTION_SECRET` in `.env.local` (64 hex chars; generate with
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
   - After applying: add keys via `/admin/keys` UI; env-var keys continue to work as fallback.

5. **Apply Phase 14 migration:**
   - `migrations/016_activity_log.sql` — adds `activity_log` table (admin-read RLS, service-role writes, 4 indexes).

6. **Apply Phase 12 migrations** (run in the SQL editor IN ORDER — 011, 012, 013):
   - `migrations/011_folders.sql` — `folders` table + `meetings.folder_id` FK + owner-only RLS.
   - `migrations/012_folder_shares.sql` — `folder_shares` table + `can_access_meeting()` SQL function
     + updated per-verb RLS on all meeting-related tables and `folders`. Must run AFTER 011.
   - `migrations/013_folders_position.sql` — `position` column on `folders` for drag-and-drop ordering.

7. **Apply AIP-06 + storage-config migrations:**
   - `migrations/027_model_control.sql` — `app_settings` table (model allow-list + system default) + `profiles.default_provider/model`.
   - `migrations/028_storage_config.sql` — `storage_config` table (admin-managed R2 credentials; secret AES-256-GCM encrypted).
     After applying, configure R2 at `/admin/storage`. R2 is DB-configured only — there is no `R2_*` env-var fallback.
     Requires `KEY_ENCRYPTION_SECRET` (same secret used for API keys) to encrypt/decrypt the secret access key.

8. **Apply API key health-check migration:**
   - `migrations/029_admin_config_health.sql` — adds `health_status` / `health_checked_at` / `health_detail`
     to `admin_config`. Powers the key health check on `/admin/keys` (see §9i). No env/config prerequisites.

9. **Apply audio-render flag migration:**
   - `migrations/031_audio_render_hack_flag.sql` — seeds the `user_hack_audio_render` row in `app_config`
     (default `false`). Toggle it at `/admin/config`. See §9j.

10. **Apply audio retention purge migration (PRV-02):**
   - `migrations/032_meetings_audio_purged.sql` — adds `meetings.audio_purged_at` + partial index.
     Apply BEFORE starting the image that contains PRV-02. Purging stays OFF until
     `storage.audio_retention_days` is set at `/admin/config`. See §9m.

11. **Apply meetings client-write revoke (BUG-003):**
   - `migrations/033_meetings_revoke_client_writes.sql` — `REVOKE INSERT, UPDATE ON meetings FROM anon, authenticated`.
     Verify with the `has_table_privilege` query in the file (all false).

12. **Apply SECURITY DEFINER RPC revoke (BUG-005):**
   - `migrations/034_revoke_definer_rpc_execute.sql` — `quota_apply_movement` and `claim_next_job` become
     service-role only. Independent of app code, so it can be applied immediately. Verify with the
     `has_function_privilege` query in the file (anon/authenticated false, service_role true).

13. **Apply transcript client-write revoke (BUG-007):**
   - `migrations/035_transcript_revoke_client_writes.sql` — browser loses INSERT/UPDATE/DELETE on
     `transcript_segments` + `transcript_chunks` (plus TRUNCATE). Independent of app code. Verify with the query in the file.

14. **Apply content-table client-write revoke (BUG-009, BUG-010):**
   - `migrations/036_content_revoke_client_writes.sql` — browser loses INSERT/UPDATE/DELETE/TRUNCATE on `todos`,
     `calendar_suggestions`, `chat_sessions`, `chat_messages`. Independent of app code. Verify with the query in the file.

15. **Apply encrypted-secret table revoke (BUG-006):**
   - `migrations/037_revoke_ciphertext_tables.sql` — `REVOKE ALL ON admin_config, storage_config FROM anon, authenticated`.
     Independent of app code. Verify with the query in the file (all false).

16. **Apply meetings client-delete revoke (BUG-008):**
   - `migrations/038_meetings_revoke_client_delete.sql` — `REVOKE DELETE, TRUNCATE ON meetings FROM anon, authenticated`.
     Independent of app code. Verify with the query in the file (all false).

## 9m. Audio retention purge (PRV-02)

Policy for people: `docs/privacy/retention-policy.md`.
- **Setting:** `app_config.storage.audio_retention_days` (seeded `null` in migration 006). A whole number
  1–3650 turns purging on; anything else = keep forever (fails closed, `parseRetentionDays`).
- **Rule** (pure, `lib/retention/policy.ts`, tested in `tests/retention.test.ts`): `isPurgeEligible` —
  `status = 'done'`, `audio_path` set, `created_at` strictly before `now − N days`.
- **Runner** (`lib/retention/purge-runner.ts`, service role): oldest first, ≤ 500 per run. Per meeting:
  re-read the row → `isOwnedAudioKey` → delete the object → compare-and-set update
  (`status='done'` + same `audio_path`) to `audio_path = NULL, audio_purged_at = now()` → audit row
  `meeting.audio_purged` (actor_id null, actor_email `system:retention`). Delete failure = row untouched,
  retried next run. Transcript/notes/todos/chat are never touched.
- **Scheduler:** `lib/retention/purgeScheduler.ts`, started from `instrumentation.ts`; first run 60s after
  startup, then every 24h (idempotent, `unref()`ed, no overlapping runs).
- **Reprocess guard:** `canReprocess` — `POST /api/meetings/:id/process` and admin requeue return **409**
  when `audio_path` is null (requeue would otherwise wipe the transcript, then fail).
- **UI:** meeting page shows "Audio deleted (retention policy)" when `audioState(meeting) === 'purged'`;
  transcript timestamps render as plain text when there is no audio.
- **Storage-key ownership rule (SEC):** `meetings.audio_path` is user-editable under RLS. Every
  service-role audio read/delete (purge, `DELETE /api/meetings/:id`, `DELETE /api/admin/users/:id`,
  `DELETE /api/folders/:id?deleteMeetings=true`, `POST /api/meetings/:id/uploaded`) MUST pass
  `isOwnedAudioKey(key, user_id, meeting_id)` (`<user_id>/<meeting_id>[.ext]`); reads (`/api/audio-url`,
  pipeline download) use `ownedAudioPath`. Client INSERT/UPDATE on `meetings` is revoked (migration 033,
  BUG-003), and DELETE/TRUNCATE too (migration 038, BUG-008). Avatar keys: `isOwnedAvatarKey` (BUG-002).

## 9n. Recording notice (COM-01)

- Clicking **Start recording** (`components/RecorderUI.tsx`) opens `components/RecordingNoticeModal.tsx`:
  notice text + suggested verbal script; recording starts only on **"I understand — start recording"**
  (Cancel / Escape / backdrop abort). `beginRecording()` runs synchronously inside that click so the
  browser's capture prompts keep user activation.
- Acknowledgement is kept per tab in `sessionStorage` for 12h (`lib/consent/recordingNotice.ts`:
  `RECORDING_NOTICE_TTL_MS`, `isNoticeAckFresh`, `parseStoredAck`; tested in `tests/recording-notice.test.ts`),
  then the notice shows again. Storage blocked / malformed / future value → notice shows.
- Each acknowledgement is logged best-effort as activity event `recording_notice_ack` (`POST /api/activity`,
  own user only, rate-limited) → visible at `/admin/activity`. It is a **self-reported trail**, not proof of
  consent: it is not tied to a specific meeting and a failed log does not block recording.
- Dialog a11y: portal into `<body>`, rest of page `inert`, focus on the heading (never the confirm button),
  Tab trapped, focus returned to the opener.
- Not built: admin toggle (notice is always mandatory); notice before file upload (upload is not recording).

## 9o. DB backup (OPS-03, Supabase Free)

- `.github/workflows/backup.yml`: daily 02:00 UTC + manual. `supabase db dump` (roles, schema, data) →
  tar.gz → `age` encrypt with the **public** key → `scripts/backup/r2.ts upload` → `prune` (only after a
  successful upload). Dump + encrypt run BEFORE `npm ci --ignore-scripts`; secrets are step-scoped and live in
  the GitHub Environment `backup`; actions pinned by SHA, Supabase CLI by exact version.
  `schedule` runs from the default branch (`dev`), so the `backup` environment must release its secrets to
  `dev` (recommended deployment branches: `main` + `dev`; as of 2026-10-25 it has no branch policy and **no
  secrets yet**, so every run fails at "Check secrets are set" — BUG-018). Trade-off accepted in the roadmap
  (2026-10-25): workflows on `dev` can read the backup secrets.
- Separate R2 bucket + token scoped to it; the app's audio bucket stays DB-configured (§9a/7).
- Naming/retention (pure, `lib/backup/retention.ts`, tested in `tests/backup-retention.test.ts`):
  `db/ricotdin-db-<yyyyMMdd>T<HHmm>Z.tar.gz.age`; delete strictly older than 30 days, never the newest,
  never non-matching keys. Upload uses `IfNoneMatch: '*'` (never overwrites).
- The private key is offline with the owner; GitHub can never decrypt a backup. Runbook + restore-test
  log: `docs/ops/backup-restore.md`. Not covered: audio/storage, project settings, PITR.

## 9i. API key health check design

**Goal:** Detect dead/revoked provider keys (the `key #N rejected with 401 — permanently disabled` case)
before they break a user request. Surfaced on `/admin/keys`.

- **Probe:** a cheap authenticated request per provider using the decrypted key.
  Gemini/OpenAI `GET /models`, Speechmatics `GET /v2/jobs?limit=1` (free — list resources).
  Gemini carries the key as a query param; the others use `Authorization: Bearer`.
  **Grok (xAI) is special:** xAI keys use per-endpoint ACLs and by default lack the
  `api-key:endpoint:models` ACL, so `GET /v1/models` returns a misleading 403 for keys that
  work fine for chat. Grok is therefore probed with a minimal `POST /v1/chat/completions`
  (`max_tokens: 1`, model `grok-3-mini`) — the endpoint the app actually uses — so the verdict
  reflects real usability. Costs ~1 output token per check. `ProbeConfig` supports `method`/`body`.
- **Verdict** (`lib/keys/healthcheck.ts`, pure + tested in `tests/key-healthcheck.test.ts`):
  2xx/429 → `healthy` (429 = valid but rate-limited); 401/403 → `unhealthy`; 5xx/other/network → `unknown`.
  A decrypt failure (KEY_ENCRYPTION_SECRET mismatch) is recorded as `unhealthy`.
- **Runner** (`lib/keys/healthcheck-runner.ts`, server-only): loads all `admin_config` key rows
  (active + disabled), decrypts in-memory, probes, writes `health_status/detail/health_checked_at`.
  Plaintext/ciphertext are never logged or returned.
- **Automation:** `lib/keys/healthScheduler.ts` — in-process daily scheduler started from
  `instrumentation.ts` (single `next start` process, no external cron). Runs on startup only if the
  last recorded run is stale (>24h), then every 24h. Timer is `unref()`ed.
- **Manual trigger:** `POST /api/admin/keys/healthcheck` (admin; audit-logged `admin_config.healthcheck`).
  `GET` returns the last run timestamp. `GET /api/admin/keys` now returns the health columns.
- **UI:** `/admin/keys` shows a Health badge + hover detail per key, a "Run health check now" button,
  and the latest run time (`= max(health_checked_at)`). Env-var fallback keys are not rows, so they
  are not health-checked.

## 9j. Audio seek / `user_hack_audio_render` flag

**Problem:** browser recordings come from `MediaRecorder` as **live-mode WebM/Opus**
(`lib/audio/support.ts`) and are uploaded byte-for-byte to R2 (`lib/upload/upload.ts`).
A live-mode WebM has an *unknown* Duration in its Segment Info header and **no Cues**
(seek index). So in `<audio>`: `duration === Infinity`, no total length is displayed,
there is no time→byte map for a Range seek, and the scrub bar only covers already-buffered
bytes. The `43m 46s` shown in the meeting header comes from `meetings.duration_seconds`
(client-measured at record time), **not** from the audio file. Uploaded mp3/m4a files are
unaffected — they seek normally.

**Mitigation (this flag, NOT a cure):** `app_config.user_hack_audio_render` (migration 031,
default `false`). When on, the player seeks once to `HACK_SEEK_TARGET` (`1e101`) after
`loadedmetadata`; the media engine scans to end-of-stream, fires `durationchange` with a real
duration, and exposes a full seekable range. The playhead is then restored.
**Cost: the entire file is downloaded up front.** Leave it off unless users complain about
seeking; the durable fix is remuxing on upload into a container with Duration + Cues
(ffmpeg is already a dependency — see `lib/audio/transcode.ts`). Remux is not built.

- Pure logic: `lib/audio/durationFix.ts` — `needsDurationFix`, `isRecoveredDuration`,
  `shouldRunDurationFix`, `resolveDuration`, `HACK_SEEK_TARGET`. Tested in
  `tests/audio-duration-fix.test.ts`.
- Client hook: `lib/audio/useAudioDurationFix.ts` — arms once per source; no-op when the file
  is already seekable, so turning the flag on is safe for mp3/m4a meetings.
- Flag delivery: `app_config` is admin-SELECT under RLS, so the browser can never read it.
  `GET /api/audio-url/:id` resolves it server-side (service role) and returns
  `{ url, hackAudioRender }` — no extra round-trip.
- Server reader: `lib/config/appConfig.ts` — `getAppConfigBool(key, fallback)`, 30s TTL cache,
  `invalidateAppConfigCache()` called from `PATCH /api/admin/config/:key` for immediate effect.
  A failed lookup returns the caller's fallback; a malformed value never flips a flag on
  (`coerceConfigBool` in `lib/admin/config.ts`).

## 9b. Auth/roles — Phase 7 design

**Role storage (NEVER in user_metadata):**
- Role is stored in `auth.users.app_metadata.role` (service-role-writable only).
- Also mirrored in `public.profiles.role` (display/join; kept in sync by server routes).
- `user_metadata` is user-writable via the SDK → NEVER store role there.

**JWT claim injection:**
- `migrations/002_jwt_hook.sql` registers `public.custom_access_token_hook`.
- The hook copies `app_metadata.role` → `user_role` JWT claim on every token issue.
- RLS policies read `auth.jwt()->>'user_role'` (no per-query subquery).
- Dashboard step: Authentication → Hooks → Custom Access Token → enable the function.

**Username → email login flow (server-side only):**
- `POST /api/auth/login` accepts `{ identifier, password }`.
- If `identifier` contains `@` → treat as email.
- Otherwise → service-role lookup: `profiles WHERE username = normalize(identifier)`,
  then `auth.admin.getUserById(profile.id)` to get the email.
- `signInWithPassword(resolvedEmail, password)` is called on the server.
- The mapping is NEVER exposed to the client; generic errors are returned on failure.

**Registration (email verification required):**
- `POST /api/auth/register` creates the user via `auth.admin.createUser` with
  `app_metadata: { role: 'user' }` and **`email_confirm: false`**. Client cannot choose a role.
- Profile row is inserted immediately after; on failure the auth user is cleaned up.
- Verification email is sent via the anon client `auth.resend({ type: 'signup', email,
  options: { emailRedirectTo: '<origin>/login' } })` — `admin.createUser` never sends mail
  itself. Returns `{ verifyEmail: true, emailSent: boolean }`.
- **No admin-approval gate** (the old auto-ban on signup was removed). The user can sign in
  as soon as they click the verification link; it lands on `/login` and the browser client
  picks up the session from the URL (`detectSessionInUrl`).
- `POST /api/auth/login` maps the Supabase `email_not_confirmed` error to a 403 with a
  "verify your email" message. A `user_banned` error now means an admin-disabled account.
- **Dashboard prerequisite:** Authentication → Providers → Email → "Confirm email" ON, and
  SMTP configured (Authentication → Emails / SMTP). Without SMTP no verification mail is sent.

**RLS: OWNER-OR-ADMIN:**
- All tables use `auth.uid() = owner_id OR auth.jwt()->>'user_role' = 'admin'`.
- Server pipeline still uses the service role key (bypasses RLS entirely).

**Admin seed script:**
```
npx tsx scripts/seed-admin.ts <email>
```
Reads `.env.local`, sets `app_metadata.role='admin'` and syncs `profiles.role`.
Run once for the first admin account; use `/admin` UI for subsequent changes.

**Column-level privilege:**
`REVOKE UPDATE ON profiles FROM authenticated; GRANT UPDATE(username) ON profiles TO authenticated;`
Normal users literally cannot UPDATE the `role` column from the browser.
The `prevent_role_escalation` trigger is a belt-and-suspenders backup.

## 9c. Admin user-management design (Phase 9)

All operations use the **Supabase Auth Admin API** (`auth.admin.*`) with the **service
role key** (server-side only). `auth.users` is not queryable from the browser.

**Endpoints:**
- `GET /api/admin/users?page&perPage&search` — paginated list with email, username, role,
  disabled (banned) + `status`, meeting_count, last_sign_in_at, created_at. Up to 1000 users
  fetched from Admin API; search + pagination applied server-side.
  - **`status` is a 3-way derived value** (`lib/admin/userStatus.ts` → `deriveUserStatus`, pure +
    tested in `tests/user-status.test.ts`): `disabled` (banned_until in future) takes precedence;
    else `unverified` (email_confirmed_at null — signed up, not yet verified); else `active`.
    The admin list/detail UI shows an Unverified / Active / Disabled badge + status filter.
    NEVER conflate "unverified" with "disabled" — they are different signals (email_confirmed_at
    vs banned_until).
- `PATCH /api/admin/users/:id/role` — change role to `'user'` or `'admin'`.
- `PATCH /api/admin/users/:id/status` — `{ disabled: boolean }` → enable/disable via
  `ban_duration = '876600h'` (disable) or `'none'` (enable).
- `POST /api/admin/users/:id/reset-password` — `auth.admin.generateLink({ type: 'recovery' })`
  triggers a recovery email. Requires SMTP configured in Supabase project settings.
  Does NOT set a password directly.
- `DELETE /api/admin/users/:id` — collects `audio_path` from all user meetings, deletes
  Storage objects (service role), then `auth.admin.deleteUser()`. DB rows cascade.

**Role sync rule:** every role change must update BOTH:
1. `auth.users.app_metadata.role` (Admin API → JWT source of truth)
2. `public.profiles.role` (display table)
Do not update one without the other. If the auth update succeeds but profiles sync fails,
log a warning (app_metadata is authoritative; profiles will be corrected on next change).

**Role change timing:** the new role takes effect on the target user's **next token
refresh**. There is an inherent delay; advise the user to sign out and back in to see
their new role reflected immediately.

**Guards** (pure functions in `lib/admin/guards.ts`, tested in `tests/admin-guards.test.ts`):
- `checkAdminRole(appMetadata)` — used by `requireAdmin`; returns `false` → HTTP 403.
- Self-action: admins cannot demote, disable, or delete **themselves**.
- Last-admin: cannot demote, disable, or delete the **last remaining admin**.
  Admin count is read from `profiles WHERE role = 'admin'` (kept in sync).

**Storage cleanup on user delete:**
Before `auth.admin.deleteUser`, gather all `meetings.audio_path` for the target user
and call `storage.from('recordings').remove(paths)`. Storage failures are logged and
returned as `storageWarnings[]` but never abort the user delete. DB rows cascade via
the `auth.users → profiles` and `auth.users → meetings` FK `ON DELETE CASCADE`.

**UI at `/admin`:**
- Shows current admin's row with a "You" badge; self-action buttons are disabled.
- Client-side search by email/username; pagination at 20 per page.
- Role change and status toggle are optimistic with revert on error.
- Delete and password-reset open confirmation dialogs before running.
- Global success/error banners with dismiss.

## 9e. AI provider usage tracking design (Phase 10b)

**Schema (`migrations/009_usage_log.sql`) — unit-aware, never conflate units:**
```
usage_log: id, created_at, provider, model, operation,
           input_tokens int null, output_tokens int null, total_tokens int null,
           audio_seconds numeric null,
           unit text ('tokens' | 'audio_seconds'),   ← primary metering unit
           quantity numeric,                          ← total_tokens OR audio_seconds
           status text ('ok'|'rate_limited'|'error'), http_code int null,
           meeting_id uuid null, user_id uuid null
```
RLS: admin SELECT only; writes via service role. 5 indexes (created_at, provider+model, operation, meeting_id, status).

**KEY RULE: NEVER aggregate `quantity` across different `unit` values.** Tokens and audio-seconds are incommensurable. Always filter by `unit` before summing.

**Central helper — `lib/usage/logUsage.ts`:**
- `logUsage(UsageEntry): void` — fire-and-forget; a logging failure NEVER breaks the real call.
- Called immediately after every AI provider request (success, rate-limit, or error).
- Normalises to `{ unit, quantity }` based on the entry type.

**Instrumentation points (optional `ctx?: { meetingId?, userId? }` added to each):**
- `lib/gemini/analyze.ts` → `analyzeTranscript(transcript, date?, ctx?)` — logs after each `generateContent` (including the strict-prompt retry), reads `response.usageMetadata` for `promptTokenCount` / `candidatesTokenCount` / `totalTokenCount`.
- `lib/gemini/embed.ts` → `embedChunks(texts, ctx?)` — logs after each batch; reads `usageMetadata` if present, falls back to `batch.length` as quantity proxy. `operation` can be `'embed'` (pipeline) or `'embed-query'` (RAG retrieval).
- `lib/gemini/answer.ts` → `answerWithContext({ …, ctx? })` — logs after `generateContent`.
- `lib/speechmatics/transcribe.ts` → `transcribeWithSpeechmatics(path, ctx?)` — logs after transcript is received; `audio_seconds = max(result.end_time)` across all raw transcript results.
- `lib/rag/retrieve.ts` → forwards `userId` to `embedChunks` as `embed-query` context.
- `lib/pipeline/processMeeting.ts` → extracts `user_id` from the claim and passes `usageCtx` to all three provider calls.
- `app/api/chat/route.ts` → passes `{ meetingId, userId }` as `usageCtx` to `retrieveContext` and `answerWithContext`.

**Admin API — `GET /api/admin/ai-usage?from=&to=&groupBy=`:**
- Server-enforced by `requireAdmin`.
- `from`/`to` = ISO 8601 (defaults: last 30 days → now).
- `groupBy=operation` further splits by operation (default: provider+model+unit only).
- Fetches filtered rows then aggregates in JS (safe for expected row counts).
- Response: `{ from, to, rows: AiUsageRow[], dailyTotals: DailyTotal[] }`.
- `AiUsageRow`: provider, model, operation (if grouped), unit, calls, total_tokens, total_input_tokens, total_output_tokens, total_audio_seconds, rate_limited_count, error_count.
- `DailyTotal`: date (YYYY-MM-DD), provider, unit, quantity — for the trend chart.

**UI at `/admin/usage` (extended, not a new page):**
- New "AI Provider Usage" section at top; existing meeting/storage sections below.
- Date-range selector (from/to inputs) + "Break down by operation" checkbox + Apply button.
- Summary tiles: Gemini calls, total/input/output tokens, STT calls, audio transcribed, 429s, errors.
- Two separate tables: "Token-metered (Gemini)" and "Audio-metered (Speechmatics)" — unit-separated.
- SVG bar chart (no external chart lib): one bar per day, stacked per provider, tooltips, per-unit chart (tokens vs audio_seconds rendered separately).
- Provider colour legend. Rate-limited/error counts highlighted in amber/red.

**Tests (`tests/usage-log.test.ts`, 14 assertions, all pure):**
- Admin guard returns 403 for non-admins.
- Token-unit row: correct field population (input/output/total tokens, null audio_seconds).
- Audio-seconds-unit row: correct field population (audio_seconds, null token fields).
- Aggregation: correct per-unit sums; tokens/audio_seconds never bleed across unit groups.

## 9f. Provider API key pool design (Phase 13 / SEC-04)

**Goal:** Admins can manage Gemini and Speechmatics API keys from a UI. Keys are never stored in plaintext. The UI is write-only (keys cannot be read back).

**Schema (`migrations/014_provider_keys.sql`):**
```
provider_keys: id, created_at, updated_at, provider ('gemini'|'speechmatics'),
               label (display name, max 80 chars),
               key_ciphertext (base64), key_iv (base64), key_auth_tag (base64),
               last4 (last 4 chars of plaintext key, display only),
               status ('active'|'disabled'), disabled_reason text null,
               last_used_at timestamptz null, created_by uuid null
```
RLS: originally admin SELECT only (014; replaced by `admin_config` in 015). Today `admin_config` / `storage_config` give
`anon`/`authenticated` no privileges at all (migration 037, BUG-006) — service-role only; the admin SELECT policies are inert.

**SECURITY RULES (absolute):**
- `key_ciphertext`, `key_iv`, `key_auth_tag` are NEVER returned in any API response, ever.
- Tables holding ciphertext (`admin_config`, `storage_config`; `provider_keys` was dropped in 015) have NO privileges for `anon`/`authenticated`
  (migration 037, BUG-006) — a column-level REVOKE under a table-level GRANT does nothing. Admin UI reads them only
  through service-role API routes that return masked rows.
- `KEY_ENCRYPTION_SECRET` (server env var, 32 bytes) is NEVER logged, never sent to client.
- Decrypted keys exist ONLY in server-side memory at call time.
- Losing `KEY_ENCRYPTION_SECRET` makes all stored DB keys unrecoverable.
- Every key mutation (create/disable/enable/delete) writes an audit log entry with only `{ provider, label }` in metadata — never ciphertext or plaintext.

**Crypto (`lib/crypto/index.ts`):**
- AES-256-GCM with a random 12-byte IV per encryption. Returns `{ ciphertext, iv, authTag }` (all base64).
- `encryptSecretWithKey(plaintext, key: Buffer)` / `decryptSecretWithKey(secret, key: Buffer)` — pure, accept explicit key buffer (unit-testable).
- `encryptSecret(plaintext)` / `decryptSecret(secret)` — public API; read `KEY_ENCRYPTION_SECRET` from env.

**Pure helpers (`lib/keys/guards.ts`):**
- `isLastActiveKey(activeCount: number): boolean` — returns true when activeCount ≤ 1; blocks disable/delete of last active key.
- `maskProviderKey(row: ProviderKeyRow): MaskedProviderKey` — strips ciphertext/IV/tag/created_by; safe to return.

**Key provider (`lib/keys/provider.ts`):**
- `getActiveKeys(provider): Promise<string[]>` — queries DB, decrypts, caches 30s; falls back to env vars if no DB keys.
- `invalidateKeyCache(provider?)` — called after mutations for immediate effect.
- Env fallback: Gemini reads GEMINI_API_KEYS, GEMINI_API_KEY_1..20, GEMINI_API_KEY; Speechmatics reads SPEECHMATICS_API_KEY.

**Provider wiring:**
- `lib/gemini/pool.ts` — async `getPoolAsync()` with 30s TTL refresh; `resetGeminiPool()` for forced invalidation.
- `lib/speechmatics/client.ts` — async `getApiKey()` via `getActiveKeys('speechmatics')`.

**Admin API (all requireAdmin, service-role client):**
- `GET /api/admin/keys` — list all keys (SAFE_SELECT only — never ciphertext).
- `POST /api/admin/keys` — accepts `{ provider, label, key }` — encrypts, inserts, returns masked record, invalidates cache.
- `PATCH /api/admin/keys/:id` — `{ status, disabled_reason? }` — last-active-key guard on disable.
- `DELETE /api/admin/keys/:id` — last-active-key guard on active key.

**UI at `/admin/keys`:**
- Per-provider table: label, `••••last4`, status badge, last_used_at. Disable/Enable + Delete buttons.
- Add form: provider dropdown, label input, key password input (write-only). On success: one-time "Key saved. It cannot be viewed again." message.
- Disable and delete have confirmation dialogs. "Keys" added to admin sidebar nav (Key icon).

**Tests (`tests/provider-keys.test.ts`, 16 assertions, all pure):**
- Round-trip encrypt/decrypt; different IV each call; tampered ciphertext/tag/wrong-key all throw; invalid key length throws.
- `isLastActiveKey` edge cases.
- `maskProviderKey` never exposes sensitive fields; JSON serialization clean.

## 9g. User activity log design (Phase 14)

**Purpose:** High-volume per-user event log for behavioural observability.
Distinct from `audit_logs` (which records rare admin actions) — this records
normal user activity. Viewable by admins only; writes via service-role.

**Schema (`migrations/016_activity_log.sql`):**
```
activity_log: id, created_at, user_id (NOT NULL → auth.users ON DELETE CASCADE),
              event_type text NOT NULL, meeting_id uuid NULL (ON DELETE SET NULL),
              target_user_id uuid NULL (ON DELETE SET NULL), metadata jsonb NULL,
              ip text NULL, user_agent text NULL
```
RLS: admin SELECT only (`auth.jwt()->>'user_role' = 'admin'`); all inserts use service-role.
Indexes: (user_id, created_at DESC), (event_type, created_at DESC), (created_at DESC), (meeting_id) WHERE NOT NULL.

**Allowed event types (ALLOWED_EVENT_TYPES in `lib/activity/types.ts`):**
- Auth: `login`, `logout`
- Recording (client best-effort): `record_start`, `record_stop`, `recording_notice_ack` (COM-01)
- Meeting lifecycle (server): `meeting_created`, `processing_done`, `processing_failed`, `chat_message`, `meeting_deleted`
- Sharing (schema ready, instrumentation TODO): `meeting_shared`, `meeting_unshared`
- `meeting_viewed` is **intentionally absent** — too noisy, low value. Enforced by test regression guard.

**Instrumentation points:**
- `app/api/auth/login/route.ts` → `login` event after successful `signInWithPassword`
- `app/api/auth/logout/route.ts` → `logout` event (best-effort hook; client calls before clearing session)
- `app/api/meetings/route.ts` (POST) → `meeting_created` after insert
- `lib/pipeline/processMeeting.ts` → `processing_done` / `processing_failed`
- `app/api/chat/route.ts` (POST) → `chat_message` after user message persisted (no content in metadata)
- `app/api/meetings/[id]/route.ts` (DELETE) → `meeting_deleted` after row delete
- `app/api/activity` (POST) → browser hook: `record_start`, `record_stop`, `recording_notice_ack` only

**Central helper (`lib/activity/logActivity.ts`):**
- `logActivity(ActivityEntry): void` — fire-and-forget; uses service-role client; never throws; never blocks caller.

**Pure helper modules (TDD, no I/O):**
- `lib/activity/types.ts` — `ALLOWED_EVENT_TYPES`, `CLIENT_EVENT_TYPES`, `ActivityEventType`, `validateEventType()`
- `lib/activity/parse.ts` — `parseActivityQueryParams(URLSearchParams)` → `{ page, perPage, userId, eventType, from, to }`
- `lib/activity/guards.ts` — `isCallerOwn(callerUserId, requestedUserId): boolean`

**Endpoints:**
- `POST /api/activity` — browser hook; accepts only CLIENT_EVENT_TYPES (`record_start`, `record_stop`, `recording_notice_ack`); validates `isCallerOwn`; in-memory rate limit 10/user/minute. Returns 422 for non-client event types, 403 for cross-user logging.
- `GET /api/admin/activity?userId=&eventType=&from=&to=&page=&perPage=` — admin-only paginated feed; joins `meetings(title)` (no content); returns `{ rows, total, page, perPage }`.

**UI:**
- `/admin/users/[id]` — "Activity" tab shows user's activity_log events (replaces previous audit_logs tab).
- `/admin/activity` — global feed page with filters (userId, eventType, date range) + pagination. Linked from admin sidebar ("Activity" / History icon).

**SECURITY guardrails (non-negotiable):**
- Metadata NEVER contains meeting content (transcript/notes/summary). Only identifiers and counts.
- `meeting_viewed` MUST NEVER be added — regression test guards the ALLOWED_EVENT_TYPES set.
- Client endpoint (`POST /api/activity`) restricted to caller's own userId + rate-limited.
- Admin endpoints: `requireAdmin` server-enforced; non-admins get 403.
- Logging is fire-and-forget — a DB failure is logged to console only, never surfaces to users.

**Tests (`tests/activity-log.test.ts`, covers pure helpers):**
- `validateEventType`: all 11 allowed types accepted; unknown + empty rejected.
- `meeting_viewed` regression guard: absent from ALLOWED_EVENT_TYPES + validateEventType returns false.
- `parseActivityQueryParams`: defaults, parsing, clamping (page ≥ 1, perPage ≤ 100).
- `isCallerOwn`: match → true; mismatch → false; empty requestedUserId → false.

## 9h. Feature registry design (Phase 15)

**Concept:** The files in `ai-instruction/features/` are read ONE TIME (by the seeder) to populate a DB table. After seeding, the **database is the single source of truth**. All runtime code reads/writes the DB only — no filesystem reads at runtime, no static imports of those files.

**Schema (`migrations/017_features.sql`):**
```
features: id, created_at, updated_at, updated_by (text),
          key text UNIQUE (e.g. 'REC-01'),
          source_path (original file path, for reference),
          module_prefix text, module_name text (denormalized),
          title text, user_story text, description text,
          content text (full markdown body of the feature section),
          status text CHECK ('done'|'partial'|'not_started'),
          priority text CHECK ('high'|'medium'|'low'|null),
          note_tags text[], depends_on text[], blocks text[],
          key_files text[], metadata jsonb, change_note text
```
RLS: admin SELECT only; all writes via service-role client.
Auto-bump trigger on updated_at.

**Seeder (`scripts/seed-features.ts`) — THE ONLY PLACE FILES ARE READ:**
- Reads `ai-instruction/features/*.md` (module files) + `ai-instruction/tracking.md`.
- Parsing logic lives in `lib/features/parser.ts` as pure functions (testable).
- `tracking.md` is authoritative for is_done status and description.
- UPSERTs by `key` — idempotent; re-running is safe.
- Reports: N features processed (X inserted, Y updated).
- Run once: `npx tsx scripts/seed-features.ts`
- Adding a feature later: `npx tsx scripts/seed-features.ts --only <KEY>[,<KEY>]` upserts just
  those keys (`lib/features/seedFilter.ts`, tested in `tests/features-seed-filter.test.ts`).
  A full re-run overwrites every edit made at `/admin/features` — never do that after seeding.

**Pure parser (`lib/features/parser.ts`):**
- `parseStatus(raw)` — maps ✅/❌/⚠️ or [x] to enum.
- `parseFeatureSection(key, title, body)` — extracts status, user_story, content.
- `parseModuleFile(rawMarkdown, sourcePath)` — parses all `### PREFIX-NN` sections.
- `parseTrackingMd(rawMarkdown)` — parses tracking.md table into a Map.
- `mergeWithTracking(feature, trackingRow)` — merges file + tracking data; tracking wins for is_done.

**DB-access service (`lib/features/index.ts`, server-only, no filesystem):**
- `listFeatures(filters?)` — list with module_prefix/status/search/page filters.
- `getFeature(key)` — fetch by key (e.g. 'REC-01').
- `updateFeature(id, fields, updatedBy)` — persist edits.

**Admin API (all `requireAdmin`):**
- `GET /api/admin/features` — list.
- `GET /api/admin/features/:id` — detail (accepts UUID or key).
- `PATCH /api/admin/features/:id` — edit; writes one `audit_logs` row (`action: 'feature.update', metadata: { key, changed_fields }`).

**UI at `/admin/features`:**
- Split-pane: left = filterable/searchable list grouped by module_prefix; right = edit panel for selected feature.
- Editable: status, priority, title, description, note_tags, depends_on, key_files, content (markdown textarea), change_note.
- "Features" (Layers icon) added to admin sidebar nav.

**Tests (`tests/features.test.ts`, 33 assertions, all pure):**
- `parseStatus`: all three values + edge cases.
- `parseFeatureSection`: status, user_story, content extraction.
- `parseModuleFile`: feature count, module metadata, key_files, source_path.
- `parseTrackingMd`: is_done, depends_on, note_tags, priority, description.
- `mergeWithTracking`: tracking wins for done, partial preserved, fallback to tracking user_story.

**ai-instruction/ directory after seeding:**
Kept as a static reference for human reading. NOT read at runtime. No runtime code imports from it. If features need to be updated, edit them in the DB at `/admin/features`.

## 9d. Admin pipeline monitor design (Phase 10a)

**Endpoints (all server-enforced by `requireAdmin`):**
- `GET /api/admin/pipeline/overview` — aggregate counts (pending/processing/done/failed/stuck) + avg_processing_secs for done meetings. Fetches all `meetings.status + created_at + updated_at` and computes in JS (service role, no RLS).
- `GET /api/admin/pipeline/jobs?status=&page=&perPage=` — metadata-only paginated list: id, title, status, created_at, updated_at, duration_seconds, error_message, owner_email, owner_username. `status=stuck` = processing older than 15 min. Never exposes summary/notes/transcript content.
- `POST /api/admin/pipeline/:id/requeue` — safe re-run for failed/stuck meetings. Steps: (1) verify status is failed or processing, (2) delete transcript_segments + todos + calendar_suggestions (transcript_chunks cascade), (3) reset meetings.status='pending' + clear error_message/summary/notes/language, (4) write `meeting.requeue` audit log, (5) fire `processMeeting()` non-awaited. Returns 422 for pending/done meetings.

**Stuck definition:** `status = 'processing' AND updated_at < now() - 15 minutes`.

**Audit log (migration 005):** `audit_logs` table with actor_id, actor_email, action, target_type, target_id, metadata jsonb, ip_address, user_agent. RLS: admin SELECT only; writes via service role. `lib/admin/audit.ts` exports `writeAuditLog()` (fire-and-forget, never throws) and `requestContext()`.

**UI at `/admin/pipeline`:**
- Status tiles (Pending/Processing/Stuck/Failed/Done + avg duration) — click a tile to filter the table.
- Filter tabs + job table: Status badge, Meeting title/id, Owner email/username, Created (GMT+7), Duration, Error snippet, Requeue button (enabled for failed/stuck only).
- "Requeue all stuck/failed" bulk button with confirmation dialog.
- 10-second auto-poll; re-fetches on filter/page changes.
- Sub-nav links: Users | Pipeline (extensible for Usage + Audit in later phases).

## 10. Working agreement (how to collaborate with me)

- Work in **small increments**, one clear goal per change, each with a concrete
  "done" check. Do not attempt the whole app in one go.
- After each working increment, **commit to git** with a clear message.
- **TDD is mandatory for all new logic:**
  - Write unit tests for every new pure function **before** writing the implementation.
  - Tests go in `tests/` with the `.test.ts` extension and must be added to the
    `npm test` script in `package.json` (v1: `legacy/tests/`, `legacy/package.json`; v2 locations: §0).
  - When **any existing logic changes**, update the corresponding tests first, then
    change the implementation.
  - Tests must be pure (no I/O, no mocks) — test pure functions extracted into `/lib`.
- **Update `ai-instruction/tracking.md`** when a feature is completed: change `[ ]`
  to `[x]` in the "Is Done?" column for every Feature Code that the work covers.
- Before making large or structural changes, briefly state the plan and wait.
- When you hit an error, surface the exact error/log rather than guessing silently.
- If a request seems to contradict this file (e.g. would expose a key to the client,
  or pull in an out-of-scope feature), flag it instead of just doing it.
- **Feature intake workflow:** to turn a new idea into a tracked feature, use the
  `/add-feature "<idea>"` skill (`.claude/skills/add-feature/SKILL.md`): ground in repo
  (dedupe/scope/code) → brainstorm Q&A → 2–3 options + recommendation → converge on the
  smallest valuable slice that passes a Definition of Ready (testable criteria, test plan,
  structural flags, done check) → approved spec → write `tracking.md` + `features/*.md`
  → `seed-features.ts --only <CODE>`. Docs only, no code.
- **Feature delivery workflow:** to build a feature from `tracking.md`, use the
  `/ship-feature <CODE>` skill (`.claude/skills/ship-feature/SKILL.md`). It sequences
  spec → plan → TDD → implement → verify → specialist review gates (subagents in
  `.claude/agents/`) → close-out → pushes `feat/<CODE>-<slug>` and opens a PR into `dev`
  automatically (draft if checks are open; never merges). Applies the rules in this section.
- **Bug workflow:** for any bug, regression or production incident, use the
  `/fix-bug "<description>"` skill (`.claude/skills/fix-bug/SKILL.md`). It logs `BUG-NNN` in
  `ai-instruction/bugs.md`, decides bugfix (`dev`) vs hotfix (`release/X.Y`, per §9k) with
  your confirmation, writes a failing regression test first, then fixes, verifies, reviews
  and walks through the §9k hotfix steps.
- **Traceability:** every branch, commit, PR title and CHANGELOG bullet carries its feature
  code or `BUG-NNN` (§9l).
- **Owner copilot:** `/copilot` (status brief), `/copilot <question>`, `/copilot plan`
  (`.claude/skills/copilot/SKILL.md`). Advises and plans only; uses the read-only
  `Project Status Analyst` agent and `scripts/backlog-snapshot.ts` for facts. Strategy and
  decisions persist in `ai-instruction/roadmap.md` (written only with owner approval).

## 11. Build order (current plan)

0. ~~Setup: scaffold Next.js+TS, apply `schema.sql`, verify Supabase + Gemini connectivity.~~ **DONE** (Phase 0 complete — `npm run dev` serves placeholder; `npm run check` verifies both credentials)
1. ~~**Recording** (highest technical risk — validate audio capture first).~~ **DONE** (Phase 1 complete — `/record` page; mic + display audio mixed via Web Audio API; `useRecorder` hook; unsupported-browser + no-system-audio warnings; Chrome/Edge only)
2. ~~**Upload + storage** (presigned URL, `meetings` row).~~ **DONE** (Phase 2 complete — anonymous auth bootstrap; server routes POST /api/meetings + POST /api/meetings/:id/uploaded; direct browser→Storage upload via signed URL; meeting list `/meetings`; placeholder detail `/meetings/[id]`. Requires dashboard: create `recordings` bucket + enable Anonymous sign-ins — see section 9a.)
3. ~~**Processing pipeline** (Gemini service layer, JSON output, chunking, retry, embeddings).~~ **DONE** (Phase 3 complete — transcribeAudio/analyzeTranscript/embedChunks in /lib/gemini; chunkSegments + processMeeting in /lib/pipeline; POST /api/meetings/:id/process trigger; auto-triggered from /uploaded; 3s polling on meetings list; ffmpeg-based long-audio chunking with clear error if ffmpeg absent; 21 unit tests; npm run test configured).
4. ~~**Results UI** (summary / note / transcript / todos).~~ **DONE** (Phase 4 complete — full meeting detail page at `/meetings/[id]`; state machine: loading → inflight (polls 3s) | failed (re-run button) | done; sections: header, audio player via signed URL, summary, markdown notes (react-markdown + rehype-sanitize), todos with optimistic checkbox toggle, calendar suggestions with dismiss, full transcript with speaker-grouped segments and mm:ss timestamps that seek the audio player; chat placeholder. New routes: GET /api/audio-url/:id, PATCH /api/todos/:id, PATCH /api/calendar-suggestions/:id.)
5. ~~**RAG chatbot** (RPC search + grounded answers with citations).~~ **DONE** (Phase 5 complete — full RAG pipeline: `lib/rag/retrieve.ts` embeds query + calls `match_transcript_chunks` RPC with user-scoped client (RLS enforces ownership); `lib/gemini/answer.ts` generates grounded JSON answer with citation validation (invented chunk_ids dropped); `POST /api/chat` route manages sessions + persists messages + streams through the full pipeline; `ChatPanel` component with optimistic UI, citation chips, session history; chat enabled in meeting detail (`/meetings/[id]`); cross-meeting `/chat` page; `Chat` button in meetings list. 12 new unit tests in `tests/rag.test.ts`. New files: `lib/supabase/user-client.ts`, `lib/rag/retrieve.ts`, `lib/gemini/answer.ts`, `app/api/chat/route.ts`, `components/ChatPanel.tsx`, `app/(routes)/chat/page.tsx`.)
6. ~~**Calendar suggestions + todos surfaced in UI** (`.ics` download).~~ **DONE** (Phase 6 complete — pure RFC 5545 ICS builder in `lib/ics/index.ts` (no deps; escaping, folding, UTC); `GET /api/calendar-suggestions/[id]/ics` with ownership check, 422 on null proposed_at (never fabricate a datetime); meeting detail UI: `.ics` download button (fetch+blob with Bearer token) when proposed_at is set, disabled span when null; todo dismiss button (PATCH status=dismissed, optimistic); metadata row always shown with "No due date" when null; past-due date styled orange/amber with ⚠ prefix; helper text on calendar section ("no automatic syncing"); 30 new unit tests in `tests/ics.test.ts`. No Google Calendar OAuth, no auto-creating events, no reminders — post-MVP only.)
7. ~~**Auth, hardening, deploy**~~ **DONE** (Phase 7 complete — email+password registration/login; username-OR-email login (server-side username→email lookup, never exposed to client); two roles: 'user' (default) and 'admin'; role stored ONLY in `app_metadata` + `profiles` table, NEVER in `user_metadata`; custom access token hook injects `user_role` JWT claim for RLS; column-level privilege blocks normal users from changing their own role; belt-and-suspenders trigger `prevent_role_escalation`; `/admin` page with user list, role toggle, ban/unban — all server-enforced (403 for non-admins); `scripts/seed-admin.ts` for initial admin bootstrap; `lib/auth/validate.ts` with 24 unit tests. Dashboard steps: apply migrations 001–003, enable custom access token hook, disable anonymous sign-ins.)
8. ~~**Meeting list actions** (pin, rename, delete)~~ **DONE** (Phase 8 complete — `pinned_at timestamptz null` column on meetings (migration 004) with composite sort index; list sort: pinned-first (most-recently-pinned on top), then created_at desc; per-row pin toggle (📌, optimistic), inline rename (optimistic, Enter to save / Escape to cancel), delete with confirmation dialog ("This permanently deletes the meeting…"); `DELETE /api/meetings/:id` removes audio from Storage before the row delete — Storage failure is logged + warned but does not block the row delete; `PATCH /api/meetings/:id` for rename; `PATCH /api/meetings/:id/pin` for pin toggle; all routes ownership-checked server-side. Apply migration 004 in Supabase dashboard.)
9. ~~**Admin user management**~~ **DONE** (Phase 9 complete — full `/admin` user-management UI + 5 API routes; all routes server-enforced by `requireAdmin` (reads `app_metadata.role`); pure guard functions in `lib/admin/guards.ts` + 21 unit tests; user list with pagination+search+meeting_count+last_sign_in_at; `PATCH /api/admin/users/:id/role` keeps app_metadata+profiles in sync; last-admin guard on demotion/disable/delete; `PATCH /api/admin/users/:id/status` enables/disables via ban_duration; `POST /api/admin/users/:id/reset-password` uses `auth.admin.generateLink({ type: 'recovery' })`; `DELETE /api/admin/users/:id` cleans up Storage audio files before deleting the auth user; UI shows "You" badge on self-row, disables self-action buttons, optimistic role/status updates with revert, confirmation dialogs for delete + password reset. See section 9c for full design.)
10. ~~**Admin operational — Area 1: Pipeline/Job Monitoring**~~ **DONE** (Phase 10a complete — `migrations/005_audit_logs.sql` (admin-readable, service-role writes, 4 indexes); `lib/admin/audit.ts` central `writeAuditLog()` fire-and-forget helper + `requestContext()` IP/UA extractor; `GET /api/admin/pipeline/overview` aggregate counts (pending/processing/done/failed/stuck) + avg_processing_secs; `GET /api/admin/pipeline/jobs?status=&page=&perPage=` metadata-only paginated list with owner email/username — NO transcript/notes content; `POST /api/admin/pipeline/:id/requeue` safe re-run: clears transcript_segments/todos/calendar_suggestions (transcript_chunks cascade), resets status to pending + clears summary/notes/language, writes audit log entry `meeting.requeue`, fires processMeeting() non-awaited; `/admin/pipeline` UI with status tiles (click to filter), filter tabs, jobs table with Requeue button per failed/stuck row, "Requeue all stuck/failed" with confirmation dialog, 10s auto-poll; 11 new unit tests in `tests/admin-pipeline.test.ts` (admin guard 403, requeue eligibility, audit entry structure). Apply migration 005 in Supabase dashboard.)
11. ~~**Admin operational — Area 2: AI Provider Usage Tracking**~~ **DONE** (Phase 10b complete — `migrations/009_usage_log.sql` unit-aware schema (tokens/audio_seconds units never conflated); `lib/usage/logUsage.ts` fire-and-forget central helper; Gemini analyze/embed/answer and Speechmatics all instrumented with optional `ctx?: { meetingId?, userId? }` parameter; processMeeting + chat route pass usageCtx; `GET /api/admin/ai-usage?from=&to=&groupBy=` aggregates in JS; `/admin/usage` page extended with AI usage section: summary tiles, token table + audio table (separate), SVG trend charts per unit, date-range selector; 14 unit tests in `tests/usage-log.test.ts`. Apply migration 009 in Supabase dashboard. See section 9e for full design.)
12. ~~**Shared folders (COM-05 / PRO-06 folders)**~~ **DONE** (Phase 12 complete — `migrations/011_folders.sql` folders table (owner-only RLS, unique name per user, ON DELETE SET NULL for meetings); `migrations/012_folder_shares.sql` folder_shares table + `can_access_meeting(uuid, text)` SQL function as single RLS source-of-truth; per-verb RLS policies replacing FOR ALL on all 9 meeting-related tables + `folders` + `folder_shares`; `lib/access/index.ts` server-side TS helpers (checkMeetingAccess, checkFolderAccess, getMeetingRole, canAssignToFolder) — mirrors SQL function, safe under service-role client; `lib/access/roles.ts` pure client-side helpers (getMeetingRole, canPin, canEdit, canDelete, canManageShares); `GET/POST /api/folders`, `PATCH/DELETE /api/folders/[id]`, `GET/POST /api/folders/[id]/shares`, `PATCH/DELETE /api/folders/[id]/shares/[granteeId]`, `PUT /api/folders/reorder`, `POST /api/users/lookup`; `components/FolderSelector.tsx`; share panel embedded in Manage Folders modal; folder filter pills with 👥 badge for shared folders; `PATCH /api/todos/[id]` and `PATCH /api/calendar-suggestions/[id]` updated to editor+ access via checkMeetingAccess; `GET /api/calendar-suggestions/[id]/ics` updated to viewer+; audio signed-URL route and chat route already used checkMeetingAccess; RAG retrieval scope unchanged (user-scoped client + updated RLS auto-includes shared meetings); 10 unit tests in `tests/folder-shares.test.ts`. Apply migrations 011 then 012 in Supabase dashboard. SEC-03 full RLS review REQUIRED.)
13. ~~**Provider API key management (SEC-04)**~~ **DONE** (Phase 13 complete — `migrations/014_provider_keys.sql` `provider_keys` table (AES-256-GCM encrypted at rest; admin-readable RLS; service-role writes); `lib/crypto/index.ts` AES-256-GCM helpers — `encryptSecretWithKey`/`decryptSecretWithKey` pure (explicit key buffer) + `encryptSecret`/`decryptSecret` (read KEY_ENCRYPTION_SECRET); `lib/keys/guards.ts` pure `isLastActiveKey(count)` + `maskProviderKey(row)` (never exposes ciphertext/IV/tag/created_by); `lib/keys/provider.ts` `getActiveKeys(provider)` async with 30s TTL cache + env-var fallback + `invalidateKeyCache()`; `GET/POST /api/admin/keys` + `PATCH/DELETE /api/admin/keys/:id` — all admin-enforced, never return ciphertext or plaintext, last-active-key guard blocks disable/delete, every mutation audit-logged with `{ provider, label }` only; `lib/gemini/pool.ts` now async with 30s TTL refresh via `getActiveKeys` + `resetGeminiPool()` export; `lib/speechmatics/client.ts` now async via `getActiveKeys`; `/admin/keys` UI with per-provider tables, write-only add form (password input, one-time confirmation), disable/enable toggle with confirm dialog, delete with confirm; "Keys" added to admin sidebar nav (Key icon); 16 unit tests in `tests/provider-keys.test.ts` (crypto round-trip, tamper detection, last-active guard, maskProviderKey security invariants). See section 9f for full design. Apply migration 014 in Supabase dashboard. **IMPORTANT:** Set KEY_ENCRYPTION_SECRET in .env — losing it makes stored keys unrecoverable.)

13. ~~**User activity log (Phase 14)**~~ **DONE** (Phase 14 complete — `migrations/016_activity_log.sql` activity_log table (admin-read RLS, service-role writes, 4 indexes); `lib/activity/types.ts` ALLOWED_EVENT_TYPES set + ActivityEventType + validateEventType() — `meeting_viewed` intentionally absent with regression-test guard; `lib/activity/parse.ts` parseActivityQueryParams() pure parser; `lib/activity/guards.ts` isCallerOwn() pure guard; `lib/activity/logActivity.ts` fire-and-forget central helper (mirrors writeAuditLog pattern); login + logout instrumented; meeting_created, processing_done/failed, chat_message, meeting_deleted all instrumented; `POST /api/activity` client endpoint (record_start/stop only, isCallerOwn guard, 10/min rate limit); `GET /api/admin/activity` admin feed with userId/eventType/from/to filters, meeting title join; `/admin/users/[id]` Activity tab updated to show activity_log data; `/admin/activity` global feed page with filters, pagination, event-type colour badges; "Activity" nav item (History icon) added to admin sidebar; 15 unit tests in `tests/activity-log.test.ts`. Apply migration 016 in Supabase dashboard. See section 9g for full design.)

14. ~~**Feature registry (Phase 15)**~~ **DONE** (Phase 15 complete — `migrations/017_features.sql` features table (UNIQUE key, module_prefix/name, title, user_story, description, content markdown, status/priority/note_tags/depends_on/blocks/key_files arrays, metadata jsonb, updated_by, change_note; admin SELECT RLS; auto-bump trigger); `lib/features/parser.ts` pure parsing functions (parseStatus, parseFeatureSection, parseModuleFile, parseTrackingMd, mergeWithTracking — no I/O, fully tested); `scripts/seed-features.ts` reads ai-instruction/features/*.md + tracking.md ONE TIME and UPSERTs 65 features by key (idempotent); `lib/features/index.ts` DB-access service (listFeatures, getFeature, updateFeature — service-role, no filesystem access); `GET/PATCH /api/admin/features` + `GET/PATCH /api/admin/features/:id` admin-enforced, PATCH writes audit log (action: feature.update); `/admin/features` split-pane UI: grouped filterable list + inline edit panel with all fields + markdown content textarea; "Features" (Layers icon) added to admin sidebar; 33 unit tests in `tests/features.test.ts`. Apply migration 017, then run `npx tsx scripts/seed-features.ts` once. See section 9h for design. After seeding, ai-instruction/features/ is a static reference only — DB is the source of truth.)

**v1.0.0 released** (2026-09-19) — see `CHANGELOG.md`. Audit Log UI (Area 3 / ADM-07) is live at `/admin/audit`.

**v1.1.0 released** (2026-10-22) — see `CHANGELOG.md` (PRV-02 retention purge, COM-01 recording notice, OPS-03 backup, OPS-04 release → deployment PR, S1 security fixes BUG-002/003/005 + client-write revokes BUG-007/009/010; migrations 032–036). Later work on `dev` is listed under `[Unreleased]`.

**v1.1.1 released** (2026-10-25) — see `CHANGELOG.md` (OPS-05 deployment-repo drafts, OPS-06 CI on dev, OPS-07 release runbook + `verify:deploy`, BUG-004/006/008/011/012/014–016, docs fix BUG-017; migrations 037–038). Last v1 release with new changes: v1 is frozen to hotfixes on `release/1.1`; work moves to the v2 re-platform (module ARC, `ai-instruction/roadmap.md` 2026-10-25). v1.1.1 is not deployed (v1 ops paused).

Keep this section in sync with actual progress; mark phases done as we go.