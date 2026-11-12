> Moved from CLAUDE.md §0.1 (ARC-19). Rules here are binding.

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
