> Moved from CLAUDE.md §0.2 (ARC-19). Rules here are binding.

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
  migration. The DDL carries the password in plaintext: never turn on statement logging for that;
  re-run to rotate if a log may have captured one. Logins get CONNECT on the owner's database
  (self-hosted Postgres revokes it from PUBLIC; ARC-20). On the Mac it runs in the API image on the
  `db` network (`docs/ops/self-hosted-postgres.md`).
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
- **Image** `app/api/Dockerfile` (python 3.12-slim + ffmpeg, uid 10001, HEALTHCHECK `/health`; build
  context = repo root since ARC-08d: `docker build -f app/api/Dockerfile .`); CI builds
  it and uploads `openapi.json` as an artifact (`python -m scripts.dump_openapi`). Behind a proxy set
  `FORWARDED_ALLOW_IPS` to the proxy subnet and keep port 8000 internal. Local:
  `uv run --env-file .env uvicorn app.main:create_app --factory --reload`. A container gets a
  runtime-only env file (`DATABASE_URL_*`, `JWT_PRIVATE_KEY`, `SMTP_*`, `MAIL_FROM`, `WEB_ORIGIN`,
  `ALLOWED_ORIGINS`, `SENTRY_DSN` - never the owner `DATABASE_URL`, so never `app/api/.env`).
