# Architecture Re-platform Module (ARC)

**Module prefix:** ARC  
**Status:** ❌ Not started — planning artifact only  
**Priority:** High — owner-approved new roadmap goal (v2.0.0); v1 frozen to hotfixes while ARC runs  
**Key files:** `app/api/` (FastAPI), `app/web/` (Vite + React), `legacy/` (v1 Next.js, removed in ARC-16), `ai-instruction/v2-tracking.md`

---

## Overview

ARC re-platforms Ricotdin from one Next.js + Supabase app into a **FastAPI backend** (`app/api`) and a
**client-side-rendered React SPA** (`app/web`, built from the Figma Make design), each built and shipped
as its own image on its own domain. Supabase is dropped entirely: Postgres moves to **Neon** (pgvector),
auth is self-built in FastAPI, file storage stays on Cloudflare R2 as today.

Approach: **build v2 in parallel, cut over once.** v1 keeps running on Supabase, untouched, until v2 is
feature-complete for every `[x]` feature and the data migration has been rehearsed. Then one cutover
(ARC-15) and the old code is deleted (ARC-16).

Owner decisions (2026-10-24/25): FastAPI + SQLAlchemy 2 + Alembic · Neon Postgres · self-built auth
(argon2 + JWT, existing SMTP) · authorization in the app layer **plus** RLS as a backstop · Postgres job
queue kept · R2 kept · migrate ALL existing data · `profiles` stays a separate table next to the new
`users` table · plain folders `app/api` + `app/web` (no submodules) · Vite + React Router + TanStack
Query + Tailwind + shadcn/ui · one new design with light/dark (3 legacy themes dropped) · bilingual
EN + VI from day one · keep `docs/`.

Only the `[x]` features are ported (76 on 2026-10-25, ARC excluded). The `[ ]` features (25) keep their status and are built after v2.

---

## Features

### ARC-00 — Repo preparation & legacy move
**Priority:** High | **Status:** ✅ Done (PR #31)

**User Story**  
As a developer, I want v1 moved to `legacy/` and empty `app/api` + `app/web` skeletons with their own CI so that v2 can be built next to a still-shippable v1.

**Context**
`app/api/` is already used by Next.js route handlers, so v2 cannot live there until v1 moves. v1 must stay buildable for hotfixes on `release/1.1` during the whole migration.

**Use Cases**
1. A hotfix for v1 is built from `legacy/` and shipped as today.
2. A PR touching only `app/api/**` runs only the API CI job.

**Frontend**
- `app/web/`: empty Vite + React + TS strict skeleton (replaced by the Figma Make import in ARC-11).

**Backend**
- `app/api/`: empty FastAPI skeleton (`pyproject.toml`, uv, ruff, mypy, pytest).

**Acceptance Criteria**
- Given the repo after the move, when `npm run build` runs in `legacy/`, then v1 builds and its Docker image starts with `/api/health` = ok.
- `git log --follow legacy/lib/pipeline/processMeeting.ts` shows pre-move history.
- CI has separate path-filtered jobs for `legacy/**`, `app/api/**`, `app/web/**`; each is green.
- CLAUDE.md has a "v2 migration" section (layout, test commands per folder) and the `/ship-feature` + `/fix-bug` skills know the pytest / vitest paths.

**Test Plan**
- No new logic. Existing `legacy` test suite must pass unchanged after the move.

**Structural flags**
- >10 files moved (whole Next app); CI + Dockerfile + release workflows paths change; CLAUDE.md + skills change.

**Done check**
- CI green on all three jobs; v1 image builds from `legacy/`.

**Out of scope**
- Any v2 logic.

**Key files**
- `legacy/**` (v1, moved with history), `legacy/lib/paths/shared.ts` + `legacy/tests/shared-path.test.ts` (resolve `ai-instruction/` from `legacy/` or the image root), `legacy/Dockerfile` + root `.dockerignore` (build context = repo root), `app/api/` (FastAPI skeleton, uv), `app/web/` (Vite skeleton), `.github/workflows/{ci,ci-api,ci-web,release,release-dev,backup}.yml`, `CLAUDE.md` §0, `.claude/skills/*`, `.github/pull_request_template.md`

---

### ARC-01 — v2 tracking matrix
**Priority:** High | **Status:** ✅ Done (PR #32)

**User Story**  
As the owner, I want every shipped feature mapped to its v2 API endpoints and web screens with a status per side so that I can see exactly what is left before cutover.

**Context**
The migration ports 76 done features, 55 route handlers (+ `version.json`), the browser's direct Supabase reads and a set of browser-only logic. Without one matrix it is impossible to know when v2 is complete.

**Use Cases**
1. Owner opens `v2-tracking.md` and sees API/FE/test status per feature code.
2. `/copilot` reports "N of 76 features ported".

**Frontend**
- n/a (docs).

**Backend**
- n/a (docs).

**Acceptance Criteria**
- Table (a): one row per `[x]` feature in `tracking.md` with columns Feature · API endpoints (v2) · API · FE screen · FE · Tests · Note; status values `todo | in_progress | done | n/a`.
- Table (b): all 55 legacy route handlers (+ `version.json`) mapped to a v2 endpoint or marked `dropped` with a reason.
- Table (d): every direct Supabase read/auth call from the browser mapped to a v2 endpoint.
- Table (c): browser-only logic to port (recorder, recording notice, upload, audio duration fix, transcript seek, .ics download, chat citations) with legacy source file.
- `tracking.md` header lists `ARC=Architecture re-platform (v2)`.

**Test Plan**
- Optional: `scripts/backlog-snapshot.ts` counts matrix statuses (pure parser + test) — only if `/copilot` needs it.

**Structural flags**
- none.

**Done check**
- Every `[x]` code in `tracking.md` appears in table (a); every `app/api/**/route.ts` path appears in table (b).

**Out of scope**
- The 26 `[ ]` features.

**Key files (expected)**
- `ai-instruction/v2-tracking.md`, `ai-instruction/tracking.md`

---

### ARC-02 — Postgres (Neon) target schema
**Priority:** High | **Status:** ✅ Done (PR #33)

**User Story**  
As the system, I want the full schema on a plain Postgres (Neon) managed by Alembic, with no Supabase dependency, so that v2 runs without Supabase.

**Context**
Today the schema relies on `auth.users`, `auth.uid()`, `auth.jwt()`, the custom access token hook and the `anon`/`authenticated` roles. All of that must be replaced while keeping every security rule from CLAUDE.md §6 (owner-or-admin, shares, revoked client writes, SECURITY DEFINER revokes).

**Use Cases**
1. `alembic upgrade head` on an empty Neon DB creates the complete v2 schema.
2. A request scoped to user A cannot read user B's meeting even if an app-layer check is missing (RLS backstop).

**Frontend**
- n/a.

**Backend**
- Alembic baseline equal to `schema.sql` + migrations 001–038 minus Supabase-only objects. **As built:** the
  baseline is *generated* (`scripts/gen_baseline.py`: replay v1 with a Supabase shim → introspect → render with
  rewrites) and committed as `migrations/sql/0001_baseline.sql`; hand-written parts in `migrations/src/`.
- New tables: `users` (id, email, password_hash, role, email_verified_at, disabled_at, last_sign_in_at, created_at,
  updated_at — `username` stays in `profiles`), `refresh_tokens`, `email_tokens` (verify / reset). `profiles`
  stays a separate table (FK → `users.id`, ON DELETE CASCADE); `profiles.role` mirrors `users.role` by trigger.
- RLS + functions use `app_user_id()` / `app_user_role()` (`current_setting('app.user_id' | 'app.role')`)
  instead of `auth.uid()` / `auth.jwt()`; roles `ricotdin_app` (RLS enforced) and `ricotdin_service` (a
  permissive `service_all` policy on every RLS table instead of BYPASSRLS, which Neon may not grant).
- Security review hardening: app privileges without TRUNCATE/TRIGGER/REFERENCES/MAINTAIN and DML only where a
  policy exists; no TEMP/CREATE for PUBLIC; definer `search_path = public, pg_temp`; downgrade guard.
- pgvector extension + HNSW cosine index on `transcript_chunks` (768 dims).

**Acceptance Criteria**
- Given an empty Neon DB, when `alembic upgrade head` runs, then it succeeds and `alembic downgrade base` succeeds too.
- Given `app.user_id` = A, when selecting `meetings` owned by B (not shared), then 0 rows.
- Given `app.user_id` = A with a viewer share on B's folder, then A can SELECT those meetings but not UPDATE them.
- No object references the `auth` schema, `anon` or `authenticated`.
- Every SECURITY DEFINER function has EXECUTE revoked from PUBLIC (except documented exceptions).

**Test Plan**
- Pure: `tests/test_catalog_diff.py`, `test_v1_rewrite.py`, `test_ddl_emit.py`, `test_baseline_render.py`,
  `test_parity.py`, `test_app_grants.py`, `test_schema_order.py`, `test_scratch_url.py`, `test_safety.py`.
- Integration (disposable `ricotdin_test_*` databases): `test_migrations_integration.py`,
  `test_schema_parity_integration.py` (v1 ↔ v2 catalog + stale-file check), `test_rls_integration.py`
  (owner, admin, viewer, editor, stranger, service; revoked writes; RAG RPC; no TRUNCATE/LOCK/TEMP/TRIGGER).

**Structural flags**
- New DB (Neon), new auth tables, RLS rewrite (SEC review required), new env var `DATABASE_URL`.

**Done check**
- `uv run --env-file .env alembic upgrade head` on the Neon `dev` branch + `uv run --env-file .env pytest` green
  (done 2026-10-25: 109 passed on Neon PG 18.6; CI green on a `pgvector/pgvector:pg18` service).

**Out of scope**
- Moving data (ARC-03).

**Key files**
- `app/api/migrations/{env.py,versions/0001_baseline.py,sql/0001_baseline.sql,src/**}`, `app/api/alembic.ini`
- `app/api/app/db/{replay,introspect,ddl,baseline,v1_rewrite,grants,parity,catalog,scratch,safety}.py`
- `app/api/scripts/gen_baseline.py`, `app/api/tests/fixtures/supabase_shim.sql`, `app/api/tests/*_integration.py`
- ORM models are not part of ARC-02; they arrive with the code that uses them (ARC-04/07).

---

### ARC-03 — Data migration Supabase → Neon (+ legacy storage → R2)
**Priority:** High | **Status:** ❌ Not started

**User Story**  
As the owner, I want a repeatable script that copies all users, meetings, transcripts, embeddings, keys and files from Supabase into v2 so that nobody loses data or has to reset their password.

**Context**
Owner chose to migrate everything. Supabase stores bcrypt password hashes (portable). New audio already lives on R2; meetings with `storage_provider='supabase'` still have files in Supabase Storage.

**Use Cases**
1. Rehearsal: run against a fresh Neon branch, read the report, throw the branch away.
2. Cutover: run once more after v1 writes stop.

**Frontend**
- n/a.

**Backend**
- `app/api/scripts/migrate_from_supabase.py`: extract (`auth.users` + `public.*`) → transform (auth.users → users, keep bcrypt hash, keep UUIDs) → load (idempotent upsert by id).
- Copy legacy Supabase Storage objects to R2 under the same key, set `storage_provider='r2'`.
- Report: row counts per table, vector count, checksum of key columns, one test decrypt of each `admin_config` / `storage_config` secret, list of storage copy failures.

**Acceptance Criteria**
- Given a migrated DB, row counts per table equal the source.
- Given a migrated user, when they log in to v2 with their old password, then login succeeds and the hash is rehashed to argon2.
- Every encrypted secret decrypts with the existing `KEY_ENCRYPTION_SECRET`.
- Running the script twice produces no duplicates and no errors.
- Every legacy Supabase audio object exists on R2 (or is listed in the report as missing at source).

**Test Plan**
- Pure: `app/api/app/migration/transform.py` → `map_auth_user()`, `map_row()` — `app/api/tests/test_migration_transform.py`.
- Rehearsal report saved under `docs/ops/v2-migration-rehearsal.md`.

**Structural flags**
- Reads production Supabase with the service role (secret handling), writes Neon + R2. Never logs secrets or content.

**Done check**
- Two rehearsals with a 100% matching report.

**Out of scope**
- The final cutover run (ARC-15).

**Key files (expected)**
- `app/api/scripts/migrate_from_supabase.py`, `app/api/app/migration/**`, `docs/ops/v2-migration-rehearsal.md`

---

### ARC-04 — FastAPI core
**Priority:** High | **Status:** ✅ Done

**User Story**  
As a developer, I want a FastAPI foundation (config, DB session, errors, logging, security headers, OpenAPI, Docker) so that every ported module follows the same rules.

**Context**
Replaces the Next.js runtime, `instrumentation.ts` and shared helpers. Must keep: secrets server-only, typed errors mapped to friendly HTTP responses, no secret/content in logs or Sentry.

**Use Cases**
1. A route declares its auth requirement once; the DB session sets `app.user_id`/`app.role` for RLS.
2. `GET /health` and `GET /version.json` back the image healthcheck.

**Frontend**
- n/a.

**Backend**
- Settings (pydantic-settings), async SQLAlchemy session per request, typed error hierarchy → HTTP, structured logging with secret redaction, Sentry (request body stripped), CORS allow-list from env, rate limiter, OpenAPI per tag, lifespan hooks for worker/schedulers, Dockerfile (python slim + ffmpeg, non-root, HEALTHCHECK).

**Acceptance Criteria**
- `GET /health` → `{"status":"ok"}` without DB/provider calls.
- `GET /version.json` returns `RICOTDIN_VERSION`, fallback build commit, then `"unknown"`.
- A request from an origin not in `ALLOWED_ORIGINS` gets no CORS headers.
- A raised domain error returns its mapped status + friendly message; the log has the detail, never a secret.
- `/openapi.json` is generated and checked into CI as an artifact.
- DB access follows CLAUDE.md §0.1 R1–R8 (from the ARC-02 security review): separate login credentials for
  `ricotdin_app`, `ricotdin_service` and `ricotdin_worker` (each reaches only its group), never the table owner, request context only
  via `set_config(..., true)` with bind parameters inside a transaction, values from the verified token and
  `users.role`, connections reset on check-in (tested), statement/lock timeouts per role.
- `ricotdin_service` is split before any worker code runs: the worker role cannot read `users` /
  `refresh_tokens` / `email_tokens`, and no runtime role can UPDATE/DELETE/TRUNCATE `audit_logs`,
  `activity_log` or `quota_ledger` (append-only). New Alembic revision + RLS tests.

**Test Plan**
- Pure: `tests/test_core_{version,errors,redact,redact_more,logging,ratelimit,ratelimit_more,settings,sentry}.py`,
  `tests/test_db_{context,identity,url,provision}.py`, `tests/test_app.py`, `tests/test_app_more.py`.
- Integration: `tests/test_session_integration.py` (R1–R8 with real logins), `tests/test_rls_integration.py`
  (worker / append-only), `tests/test_migrations_integration.py` (0002 down = 0001).

**Structural flags**
- New runtime, new image, migration 0002; env vars `DATABASE_URL_APP` / `_SERVICE` / `_WORKER`, `ALLOWED_ORIGINS`,
  `SENTRY_DSN`, `LOG_LEVEL`, `API_DOCS`, `DB_STATEMENT_TIMEOUT_MS`, `DB_LOCK_TIMEOUT_MS`, `RICOTDIN_VERSION`
  (`DATABASE_URL` = owner, migrations/tests only). `JWT_*`, `SMTP_*` move to ARC-05.
- The per-request identity dependency ("session per request", use case 1) is completed by ARC-05:
  ARC-04 ships `Database.app_transaction(identity)` + `get_database`.

**Done check**
- `docker run` the API image → healthcheck healthy; `pytest` green.

**Out of scope**
- Business endpoints.

**Key files**
- `app/api/app/main.py`, `app/api/app/core/{settings,errors,redact,logging,http,sentry,version,ratelimit}.py`
- `app/api/app/db/{session,context,identity,urls,provision}.py`, `app/api/scripts/{provision_db_roles,dump_openapi}.py`
- `app/api/migrations/{versions/0002_runtime_roles.py,sql/0002_runtime_roles*.sql}`, `app/api/Dockerfile`
- Env vars `JWT_*`, `SMTP_*` move to ARC-05 (first used there).

---

### ARC-05 — Self-managed auth
**Priority:** High | **Status:** ❌ Not started

**User Story**  
As a user, I want to register, verify my email, sign in with email or username, reset my password and stay signed in so that I can use v2 without Supabase.

**Context**
Replaces Supabase Auth and the JWT hook (AUT-*, §9b). Same rules: role never client-writable, generic errors, username→email lookup never exposed, unverified ≠ disabled.

**Use Cases**
1. Register → verification email (SMTP) → click → sign in.
2. Access token expires → SPA silently refreshes via cookie.
3. Admin disables a user → their next refresh fails.

**Frontend**
- n/a here (screens in ARC-13).

**Backend**
- `POST /auth/register|login|logout|refresh|verify-email|forgot-password|reset-password`, `POST /profile/change-password`.
- argon2id hashes; bcrypt verify for migrated users then rehash.
- Access JWT (EdDSA, ~15 min, claims `sub`, `role`) + JWKS at `/.well-known/jwks.json`; refresh token opaque, hashed in `refresh_tokens`, rotated on use, `HttpOnly; Secure; SameSite=Lax` cookie scoped to `/auth/refresh`; Origin check on refresh.
- Email tokens single-use, hashed, expiring.

**Acceptance Criteria**
- Given an unverified user, when they log in, then 403 "verify your email".
- Given a disabled user, when they refresh, then 401 and all their refresh tokens are revoked.
- Given a reused (already rotated) refresh token, then the whole token family is revoked.
- Login with an unknown identifier and with a wrong password return the same generic error.
- A client cannot set `role` through any endpoint.

**Test Plan**
- Pure: `app/api/app/auth/validate.py` (port of `lib/auth/validate.ts` cases), `tokens.py` → `is_expired()`, `should_revoke_family()`; `identifier.py` → `classify_identifier()` — `tests/test_auth_*.py`.

**Structural flags**
- Auth change (SEC review), new env vars `JWT_PRIVATE_KEY`, `SMTP_HOST|PORT|USER|PASSWORD|FROM`, `WEB_ORIGIN`.

**Done check**
- pytest green + manual register → verify → login → refresh on staging.

**Out of scope**
- MFA, SSO, OAuth providers.

**Key files (expected)**
- `app/api/app/auth/**`, `app/api/app/routers/auth.py`, `app/api/app/email/**`

---

### ARC-06 — Platform services: crypto, key pool, config, storage
**Priority:** High | **Status:** ❌ Not started

**User Story**  
As the system, I want encryption, the provider key pool, app config and R2 storage ported to Python so that pipeline, chat and admin can be built on them.

**Context**
`KEY_ENCRYPTION_SECRET` ciphertexts written by v1 must decrypt in v2 — otherwise all stored keys are lost (§9f). Storage-key ownership rules (`ownedAudioPath`, `isOwnedAudioKey`, `isOwnedAvatarKey`) must be kept.

**Use Cases**
1. Pipeline asks for an active Gemini key; pool returns one with cooldown/rotation.
2. Server presigns an R2 upload URL for `<user_id>/<meeting_id>.webm`.

**Frontend**
- n/a.

**Backend**
- AES-256-GCM (`cryptography`), key pool with 30s cache + env fallback, `app_config` reader with 30s TTL + invalidation, `storage_config`, R2 client (boto3) presign/get/delete, ownership checks.

**Acceptance Criteria**
- Given a ciphertext produced by v1 (fixture), when decrypted in v2, then the plaintext matches.
- Tampered ciphertext / tag / wrong key raise.
- `is_owned_audio_key` accepts `<uid>/<mid>[.ext]` and rejects any other key.
- A malformed config value never turns a flag on.

**Test Plan**
- Ports of `tests/provider-keys.test.ts`, `key-pool-*.test.ts`, `storage-config.test.ts`, `avatar-key.test.ts` → `app/api/tests/test_crypto.py`, `test_key_pool.py`, `test_storage_keys.py`, `test_config.py`; shared fixtures in `app/api/tests/fixtures/v1/`.

**Structural flags**
- Secrets handling (SEC review).

**Done check**
- pytest green incl. the v1-ciphertext fixture.

**Out of scope**
- Admin UI for keys/storage (ARC-14).

**Key files (expected)**
- `app/api/app/services/crypto.py`, `keys/**`, `config.py`, `storage/**`

---

### ARC-07 — Core domain API: meetings, folders, todos, calendar, profile, quota
**Priority:** High | **Status:** ❌ Not started

**User Story**  
As a user, I want my meetings, folders and shares, to-dos, calendar suggestions, profile and quota available through the v2 API so that every non-AI screen can be built.

**Context**
Ports MMG, MTD, CAL, PRF (done parts), folder sharing (Phase 12), QUO. Delete rule (§6: audio removed first, warning on failure) and owner/editor/viewer rules must be identical.

**Use Cases**
1. Create meeting → presigned upload → mark uploaded → job enqueued.
2. Editor of a shared folder checks a to-do; viewer cannot.

**Frontend**
- n/a.

**Backend**
- Routers: meetings (list/create/get/rename/pin/delete/uploaded/process/regenerate), audio-url, folders + shares + reorder, users/lookup, todos, calendar-suggestions + `.ics`, profile + avatar + preferences, quota balance.

**Acceptance Criteria**
- Every endpoint in table (b) of `v2-tracking.md` for these modules returns the same status codes as v1 for owner / editor / viewer / stranger.
- Deleting a meeting removes the R2 object first; on storage failure the row is still deleted and the response has `warning`.
- `.ics` for a suggestion without `proposed_at` returns 422.
- Reprocess of a purged meeting returns 409.

**Test Plan**
- Ports of `ics`, `folder-shares`, `quota`, `retention` (canReprocess), `transcript-export` tests → `app/api/tests/test_*.py`; route tests with an httpx client against a test DB.

**Structural flags**
- >10 files; authz everywhere (SEC review).

**Done check**
- Matrix rows for MMG/MTD/CAL/PRF/QUO = API done; pytest green.

**Out of scope**
- Pipeline execution (ARC-08).

**Key files (expected)**
- `app/api/app/routers/{meetings,folders,todos,calendar,profile,quota}.py`, `app/api/app/services/access.py`

---

### ARC-08 — Processing pipeline, worker & schedulers
**Priority:** High | **Status:** ❌ Not started

**User Story**  
As a user, I want my uploaded or recorded audio processed into transcript, summary, notes, to-dos, calendar suggestions and embeddings by v2 so that results match v1.

**Context**
Highest-risk port (PRP, AIP, REL, PRV-02, §7, §9e, §9i, §9m). All provider calls go through one AI service layer; JSON mode + defensive parse; 429 backoff; long-audio chunking with ffmpeg; Files API upload; usage and activity logging; quota idempotent deduction.

**Use Cases**
1. 45-minute WebM upload → done with correct stitched timestamps.
2. Provider returns 429 → retried with backoff, then fallback model.
3. Daily retention purge deletes old audio only.

**Frontend**
- n/a.

**Backend**
- Worker process (same image, separate command) claiming jobs with `SKIP LOCKED`; steps ported from `lib/jobs/steps`; adapters Gemini / OpenAI / Grok / Speechmatics; ffmpeg/ffprobe; prompt read from `ai-instruction/ai-gen/`; schedulers: key health check (daily), retention purge (daily), both idempotent with no overlap.

**Acceptance Criteria**
- Given the same fixture transcript JSON, v2 parsing produces the same segments/todos/suggestions as v1.
- Given a 0-segment result, the meeting is not marked done.
- Two worker processes never process the same job.
- A quota charge happens exactly once per job across retries/restarts.
- Usage rows keep `unit` separated (tokens vs audio_seconds).

**Test Plan**
- Ports of `chunk`, `pipeline-parse`, `processMeeting-guard`, `transcode`, `ffprobe`, `speechmatics`, `ai-*`, `aip-*`, `usage-*`, `key-healthcheck`, `retention`, `error-message` tests → pytest, using shared JSON fixtures.

**Structural flags**
- New process type (worker), ffmpeg in image, provider keys, >10 files.
- From the ARC-04 security review: run the worker as its **own container with only
  `DATABASE_URL_WORKER`** (an RCE via ffmpeg/untrusted audio must not reach the service credential),
  and replace "service minus auth tables" with an explicit per-table allow-list for `ricotdin_worker`
  (new Alembic revision + RLS tests).

**Done check**
- Process the same 3 sample recordings in v1 and v2 staging; outputs equivalent; pytest green.

**Out of scope**
- Remux-on-upload (not built in v1 either).

**Key files (expected)**
- `app/api/app/worker/**`, `app/api/app/pipeline/**`, `app/api/app/ai/**`, `app/api/app/schedulers/**`

---

### ARC-09 — Chat / RAG API
**Priority:** High | **Status:** ❌ Not started

**User Story**  
As a user, I want to ask questions about one meeting, a folder or all my meetings and get grounded answers with timestamp citations from v2.

**Context**
Ports RAG-01..04 and AIP-04 chat model rule. Retrieval must stay scoped to meetings the caller can access (now enforced by app layer + RLS instead of the user-scoped Supabase client).

**Use Cases**
1. Ask inside a meeting → answer with citations `mm:ss`.
2. Ask across a shared folder → only accessible meetings are searched.

**Frontend**
- n/a.

**Backend**
- `POST /chat`, chat sessions/messages endpoints, query embedding (768), `match_transcript_chunks` with access filter, grounded answer with invented citation ids dropped.

**Acceptance Criteria**
- Given chunks from a meeting the caller cannot access, they never appear in retrieval.
- Citations referencing unknown chunk ids are dropped.
- "Not found" answer when nothing relevant is retrieved.

**Test Plan**
- Ports of `rag-folder`, `aip04-chat-model` tests + `tests/test_rag_scope.py` (integration).

**Structural flags**
- Authz on retrieval (SEC review).

**Done check**
- Matrix RAG rows = API done; pytest green.

**Out of scope**
- New retrieval features (hybrid search, re-ranking).

**Key files (expected)**
- `app/api/app/routers/chat.py`, `app/api/app/rag/**`

---

### ARC-10 — Admin API
**Priority:** High | **Status:** ❌ Not started

**User Story**  
As an admin, I want all admin operations (users, pipeline, usage, keys, storage, config, activity, audit, features, health) on the v2 API so that the admin screens can be rebuilt.

**Context**
Ports ADM-*, §9c, §9d, §9f, §9g, §9h, §9i. Guards: self-action, last-admin, last-active-key; ciphertext never returned; every mutation audit-logged.

**Use Cases**
1. Admin disables a user → refresh tokens revoked, audit row written.
2. Admin requeues a failed meeting.

**Frontend**
- n/a.

**Backend**
- Routers under `/admin/*` mirroring the 28 legacy admin routes; role change updates `users.role` and `profiles.role` together; user delete removes R2 audio first.

**Acceptance Criteria**
- Non-admin → 403 on every `/admin/*` route.
- Admin cannot demote/disable/delete themselves or the last admin.
- No response ever contains ciphertext, IV, auth tag or plaintext keys.
- Every mutation writes one `audit_logs` row without content.

**Test Plan**
- Ports of `admin-*`, `user-status`, `activity-log`, `features*`, `usage-by-user`, `rate-limit` tests → pytest.

**Structural flags**
- >10 files; admin authz (SEC review).

**Done check**
- Matrix ADM rows = API done; pytest green.

**Out of scope**
- New admin features.

**Key files (expected)**
- `app/api/app/routers/admin/**`

---

### ARC-11 — Import Figma Make frontend
**Priority:** High | **Status:** ❌ Not started

**User Story**  
As a developer, I want the Figma Make source turned into a clean `app/web` foundation (routing, tokens, i18n, runtime config, API client, auth flow) so that screens can be wired to the API.

**Context**
Figma Make output is a prototype: mock data, state-based navigation, hard-coded strings. Owner chose Tailwind + shadcn/ui, one design with light/dark, EN + VI.

**Use Cases**
1. Deep link `/meetings/<id>` loads the right screen after sign-in.
2. User switches VI ↔ EN; choice persists.

**Frontend**
- Audit + cleanup (TS strict, remove unused deps), React Router routes, design tokens as CSS variables with light/dark, i18n (EN/VI resource files), `config.json` read at runtime (`apiUrl`, `authUrl`), API client generated from `/openapi.json` (openapi-typescript), TanStack Query, auth provider (in-memory access token, silent refresh), route guards (user/admin), error boundary.

**Backend**
- n/a.

**Acceptance Criteria**
- `npm run build` in `app/web` outputs static files; same image works for staging and prod by swapping `config.json`.
- No hard-coded user-facing string outside the i18n files (lint rule).
- Unauthenticated access to any app route redirects to sign-in and returns to the original URL after login.
- Non-admin cannot reach `/admin/*` routes.

**Test Plan**
- Pure (vitest): `app/web/src/lib/config.ts` → `parseRuntimeConfig()`, `auth/token.ts` → `isExpiringSoon()`, `i18n/locale.ts` → `resolveLocale()`.

**Structural flags**
- New FE build + image (nginx), >10 files.

**Done check**
- Web image serves the app; sign-in works against staging API.

**Out of scope**
- Wiring individual screens (ARC-13/14).

**Key files (expected)**
- `app/web/src/{app,routes,lib,i18n,components/ui}/**`, `app/web/Dockerfile`

---

### ARC-12 — Port browser-only logic
**Priority:** High | **Status:** ❌ Not started

**User Story**  
As a user, I want recording, the recording notice, uploads and audio playback to behave exactly as in v1 inside the new UI.

**Context**
These features have no server equivalent and are not in the Figma Make output: REC-01..05, COM-01, MTD-02, §9j, §9n.

**Use Cases**
1. Start recording → notice → tab + mic mixed → upload to R2 → processing.
2. Click a transcript timestamp → player seeks.

**Frontend**
- Port `lib/audio/*` (capture, support, useRecorder, durationFix, useAudioDurationFix), `lib/consent/recordingNotice.ts`, `lib/upload/upload.ts`, ICS download, citation → seek.

**Backend**
- n/a.

**Acceptance Criteria**
- Recording notice blocks recording until acknowledged; ack fresh for 12h per tab.
- Missing system audio shows the warning; unsupported browser shows the notice.
- Upload rejects files > 500 MB and non-audio types before uploading.
- With `hackAudioRender` on, a live WebM gets a finite duration and is seekable.

**Test Plan**
- Ports of `recording-notice`, `audio-duration-fix` tests to vitest; pure helpers moved to `app/web/src/lib/**`.

**Structural flags**
- none beyond ARC-11.

**Done check**
- Manual: record 2 min in Chrome with tab audio → meeting processed in staging.

**Out of scope**
- Remux on upload.

**Key files (expected)**
- `app/web/src/lib/audio/**`, `app/web/src/lib/consent/**`, `app/web/src/lib/upload/**`

---

### ARC-13 — Wire user screens
**Priority:** High | **Status:** ❌ Not started

**User Story**  
As a user, I want every user screen of the new design (auth, meetings, folders, record, meeting detail, chat, profile) working against the v2 API.

**Context**
Uses ARC-11 foundation + ARC-12 logic on top of ARC-05/07/08/09 endpoints.

**Use Cases**
1. Full core flow: sign in → record/upload → processing → results → chat.

**Frontend**
- Screens per `v2-tracking.md` table (a) FE column; loading/empty/error states; EN + VI strings.

**Backend**
- n/a.

**Acceptance Criteria**
- Every user-facing `[x]` feature row has FE = done.
- Playwright smoke passes the core flow on staging in EN and VI.
- Optimistic updates (pin, rename, todo, dismiss) revert on error.

**Test Plan**
- vitest for any new pure helper; Playwright `app/web/e2e/core-flow.spec.ts`.

**Structural flags**
- >10 files.

**Done check**
- Playwright green on staging.

**Out of scope**
- Admin screens.

**Key files (expected)**
- `app/web/src/routes/(user)/**`

---

### ARC-14 — Wire admin screens
**Priority:** High | **Status:** ❌ Not started

**User Story**  
As an admin, I want every admin screen working against the v2 admin API.

**Context**
Uses ARC-10. Same guards shown in UI (You badge, disabled self-actions, confirm dialogs, write-only key field).

**Use Cases**
1. Admin adds a key → one-time "cannot be viewed again" message.

**Frontend**
- Users, user detail, pipeline, usage (charts), keys, storage, config, activity, audit, features, health, API docs.

**Backend**
- n/a.

**Acceptance Criteria**
- Every ADM `[x]` row has FE = done.
- Playwright admin smoke: list users, requeue a failed job, run key health check.

**Test Plan**
- vitest for chart/aggregation helpers; Playwright `app/web/e2e/admin.spec.ts`.

**Structural flags**
- >10 files.

**Done check**
- Playwright admin smoke green on staging.

**Out of scope**
- New admin features.

**Key files (expected)**
- `app/web/src/routes/admin/**`

---

### ARC-15 — Cutover & v2.0.0 release
**Priority:** High | **Status:** ❌ Not started

**User Story**  
As the owner, I want a rehearsed, reversible switch from v1 to v2 so that users move to v2 with all their data and minimal downtime.

**Context**
v1 stays on Supabase until this point. Rollback must be possible because Supabase is left untouched.

**Use Cases**
1. Planned window: v1 read-only → final migration → verify → DNS switch.
2. Problem found → DNS back to v1.

**Frontend**
- n/a.

**Backend**
- Release: `release.yml` builds `ricotdin-api` + `ricotdin-web` for one tag; deployment PR pins both digests; backup workflow switched to `pg_dump` on Neon; runbook `docs/ops/v2-cutover.md`.

**Acceptance Criteria**
- Staging rehearsal of the full runbook completed once end to end.
- After cutover: migration report 100% match, Playwright smoke green on production.
- Rollback procedure tested on staging.
- `CHANGELOG.md` `[2.0.0]` with deploy checklist (env vars, DNS, Neon, SMTP).

**Test Plan**
- No new logic; `lib/backup/retention` port tested in pytest if the backup script moves to Python.

**Structural flags**
- Production data move, DNS, new env vars, new images, deployment repo change.
- From the ARC-04 review: `FORWARDED_ALLOW_IPS` = proxy subnet with port 8000 internal only; pin base images
  and CI actions by digest/SHA; `API_DOCS` off in production; provision production logins with
  `scripts.provision_db_roles` against the `main` branch.

**Done check**
- v2.0.0 live; first nightly Neon backup uploaded.

**Out of scope**
- Deleting Supabase (ARC-16).

**Key files (expected)**
- `.github/workflows/release.yml`, `.github/workflows/backup.yml`, `docs/ops/v2-cutover.md`, `CHANGELOG.md`

---

### ARC-16 — Remove legacy & decommission Supabase
**Priority:** Medium | **Status:** ❌ Not started

**User Story**  
As a developer, I want all v1 code and Supabase dependencies removed so that the repo only contains `app/api`, `app/web`, `ai-instruction`, `docs` and tooling.

**Context**
Final repo layout approved by the owner. Supabase is shut down only after v2 has run stably (e.g. 30 days) and a final backup exists.

**Use Cases**
1. New contributor clones the repo and only sees the v2 layout.

**Frontend**
- n/a.

**Backend**
- Delete `legacy/`, root Next/Supabase configs, old TS tests, Supabase scripts; rewrite CLAUDE.md for v2; update skills/agents paths; final Supabase backup then project shutdown.

**Acceptance Criteria**
- `git grep -i supabase` and `git grep "next/"` return nothing outside `CHANGELOG.md` / docs history.
- CI has only `api` and `web` jobs, both green.
- CLAUDE.md describes only v2.

**Test Plan**
- No new logic.

**Structural flags**
- Mass deletion; Supabase project shutdown (irreversible — owner confirms).

**Done check**
- CI green; repo tree = approved layout.

**Out of scope**
- —

**Key files (expected)**
- `CLAUDE.md`, `.github/workflows/*`, root config files

---

## Build Order

ARC-00 → ARC-01 → ARC-02 → ARC-04 → ARC-03 → ARC-05 → ARC-06 → ARC-07 → ARC-08 → ARC-09 → ARC-10 →
ARC-11 → ARC-12 → ARC-13 → ARC-14 → ARC-15 → ARC-16.
ARC-11/12 may start once ARC-05 OpenAPI is frozen (parallel to ARC-07..10).

## Dependencies

**Depends on:** all `[x]` features (they define v2 parity).  
**Blocks:** every `[ ]` feature (built on v2 after ARC-15).
