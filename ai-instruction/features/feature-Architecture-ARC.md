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
**Priority:** High | **Status:** ⚠️ Partial — script + tests done; the two owner rehearsals (done check) are pending

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

**Key files**
- `app/api/scripts/migrate_from_supabase.py` (I/O), `app/api/app/migration/{transform,plan,checksum,report}.py` (pure)
- Tests: `app/api/tests/test_migration_transform.py`, `test_migration_integration.py` (v1 replay with
  GoTrue columns + `storage.objects` → v2 at head; includes a real v2 login with the old password)
- Runbook + rehearsal log: `docs/ops/v2-migration-rehearsal.md`

**Delivered**
- All five acceptance criteria are covered by integration tests on synthetic data.
- Open:
  - The two rehearsals on throwaway Neon branches (owner, production credentials).
  - No hard refusal of Neon `main` as the target: `--confirm-target` only.
  - A re-run overwrites `users.*`, so the final run must happen before v2 accepts logins (ARC-15).
  - `KEY_ENCRYPTION_SECRET` re-key is a follow-up.

---

### ARC-04 — FastAPI core
**Priority:** High | **Status:** ✅ Done (PR #34)

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
**Priority:** High | **Status:** ✅ Done (PR #35)

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

**As built (ARC-05)**
- `app/api/app/auth/{validate,identifier,passwords,tokens,jwt,cookies,runtime,service,deps}.py`,
  `app/api/app/routers/{auth,profile}.py`, `app/api/app/email/{sender,templates}.py`,
  `app/api/scripts/gen_jwt_key.py`; tests `app/api/tests/test_auth_*.py` (pure) +
  `test_auth_integration.py`. Design summary: CLAUDE.md §0.3.
- Added beyond the spec: `GET /auth/me`, `POST /auth/resend-verification`, login Origin check,
  `JWT_PREVIOUS_PUBLIC_KEY` rotation overlap, 10 s refresh race window (not treated as theft).
- Owner decisions 2026-10-26: role/disable effective within 15 min (token), web + API on sibling
  subdomains (SameSite=Lax), duplicate email -> 409.
- Open: pre-registration of an unverified email (CLAUDE.md §0.3), absolute session lifetime,
  secret scanning (gitleaks) in CI.

---

### ARC-06 — Platform services: crypto, key pool, config, storage
**Priority:** High | **Status:** ✅ Done

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

**Key files**
- `app/api/app/services/crypto.py`, `cache.py`, `config.py`, `platform.py`
- `app/api/app/services/keys/{pool,source,guards}.py`, `storage/{config,r2,ownership}.py`
- Tests: `app/api/tests/test_crypto.py`, `test_key_pool.py`, `test_key_source_failure.py`,
  `test_platform_pure.py`, `test_platform_review.py`, `test_platform_integration.py`;
  fixture `app/api/tests/fixtures/v1/crypto_v1.json` (synthetic key). The planned
  `test_storage_keys.py` / `test_config.py` live in `test_platform_pure.py`.

**Delivered**
- All four acceptance criteria covered by tests; CLAUDE.md §0.4 describes the runtime.
- Open follow-ups: `KEY_ENCRYPTION_SECRET` rotation (no key id / previous-key decrypt, same as
  v1); ownership is the caller's duty (R2Storage accepts any key); ARC-07 must always pass
  `content_length` on upload presign; ARC-08 owns one pool per provider; optional startup
  refusal when `KEY_ENCRYPTION_SECRET` is unset.

---

### ARC-07 — Core domain API: meetings, folders, todos, calendar, profile, quota
**Priority:** High | **Status:** ✅ Done — part 1 (PR #40) and part 2 (files in Google Drive, ARC-17)

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
- Deleting a meeting removes the Drive file (ARC-17) first; on storage failure the row is still deleted and the response has `warning`.
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

**Key files**
- Part 1: `app/api/app/routers/{meetings,content,folders,profile,activity,_common}.py`, `app/api/app/services/access.py`, `app/api/app/domain/{access,rules,ics,models}.py`
- Tests: `app/api/tests/test_{ics,domain_access,domain_rules,domain_models}.py` (pure), `test_core_domain_integration.py` (role matrix on a scratch DB)
- Part 2: `app/api/app/domain/uploads.py`, `app/api/app/routers/{meetings,folders,profile}.py`, migration `0004_meetings_gdrive`
- Tests part 2: `test_domain_uploads.py` (pure), `test_meetings_storage_integration.py` (scratch DB + fake Drive)
- `regenerate` moved to ARC-08 (needs the analysis step); ffprobe check and video → audio extraction move to the ARC-08 worker.

**Decided 2026-11-02 (owner):** only the meeting owner may move a meeting to another folder (403 otherwise); editors still rename. Closes the CWE-269 finding of the part 1 security review.

---

### ARC-08 — Processing pipeline, worker & schedulers
**Priority:** High | **Status:** ✅ Done — 08a–08e (worker foundation, transcription, AI layer + analyse, embed + deploy target, schedulers)

**User Story**  
As a user, I want my uploaded or recorded audio processed into transcript, summary, notes, to-dos, calendar suggestions and embeddings by v2 so that results match v1.

**Context**
Highest-risk port (PRP, AIP, REL, PRV-02, §7, §9e, §9i, §9m). All provider calls go through one AI service layer; JSON mode + defensive parse; 429 backoff; Speechmatics transcription; usage and activity logging; quota idempotent deduction. Gemini audio transcription, Files API upload and long-audio chunking are **not ported** (owner decision 2026-11-02: that v1 code path was dead; Speechmatics transcribes).

**Use Cases**
1. 45-minute WebM upload → done with correct stitched timestamps.
2. Provider returns 429 → retried with backoff, then fallback model.
3. Daily retention purge deletes old audio only.

**Frontend**
- n/a.

**Backend**
- Worker process (same image, separate command) claiming jobs with `SKIP LOCKED`; steps ported from `lib/jobs/steps`; adapters Gemini / OpenAI / Grok (analysis, embeddings) + Speechmatics (transcription); ffmpeg/ffprobe (validate, video → audio, transcode); prompt read from `ai-instruction/ai-gen/`; schedulers: key health check (daily), retention purge (daily), both idempotent with no overlap.

**Acceptance Criteria**
- Given the same fixture transcript JSON, v2 parsing produces the same segments/todos/suggestions as v1.
- Given a 0-segment result, the meeting is not marked done.
- Two worker processes never process the same job.
- Given a meeting with a queued or running job, when `POST /meetings/{id}/process` is called again, then no second job is queued (v1 and ARC-07 part 1 insert one per call; fix before the worker goes live, plus a per-user limit) — ARC-07 security review 2026-10-29.
- A quota charge happens exactly once per job across retries/restarts.
- `jobs.payload.preferred_provider` / `preferred_model` (written by `POST /meetings/{id}/uploaded`, v1 parity, unchecked there) are used only if they are on the model allow-list (`app/domain/models.py`); otherwise the default model.
- Usage rows keep `unit` separated (tokens vs audio_seconds).

**Test Plan**
- Ports of `chunk` (RAG segment chunking), `pipeline-parse`, `processMeeting-guard`, `transcode`, `ffprobe`, `speechmatics`, `ai-*`, `aip-*`, `usage-*`, `key-healthcheck`, `retention`, `error-message` tests → pytest, using shared JSON fixtures.

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

**Slices**
- **08a worker foundation — done (branch `feat/ARC-08-pipeline-worker`):** `JobRunner` (claim,
  dispatch, retry/terminal/refund, stuck sweep, per-job deadline, release on shutdown), step
  `start` up to the transcriber submit (`Transcriber` protocol), ffprobe / extraction / transcode
  with input guards, `python -m app.worker` (refuses extra credentials and missing steps),
  migration `0005_worker_grants` (worker allow-list + one active job per meeting + quota
  wrappers `pipeline_reserve/refund/settle`), `process` dedupe + 30/h limit + 409 while uploading,
  ARC-03 preflight for duplicate active v1 jobs. Review round 1 (2026-11-02): no general quota
  function for the worker, ffmpeg without secrets in its env and with RLIMITs, user-facing error
  messages only. Not deployable until 08b–08d.
- **08b Speechmatics transcription — done (branch `feat/ARC-08b-transcription`):** json-v2 parse
  (40 v1 tests ported, defensive against malformed input), `SpeechmaticsTranscriber` (one key
  per provider job, least-busy key by jobs in flight per `key_ref`, retry 429/5xx/network 8×,
  401 disables the key, other 4xx terminal, POST retried only when no job can exist, 32 MiB
  transcript cap), step `transcribe_poll`
  (poll every 5 s; done → settle + segments + language + usage in one lock-guarded transaction,
  re-run skips to `analyse`; language-detect rejection → one resubmit with `en`). Submit uses
  auto-detect like v1 (08a passed `meetings.language`).
- **08c AI layer — done (branch `feat/ARC-08c-ai-analyse`):** `app/services/ai/` — catalog
  (providers + models, pure data), neutral response schema converted per provider, adapters over
  REST (Gemini; OpenAI-compatible: OpenAI, Grok), `AIService` (one key pool per provider, same-key
  strict retry, usage row per call incl. failures), per-meeting model lock (pick → user default →
  system default, allow-listed only), step `analyse`, `POST /meetings/{id}/regenerate` (owner,
  409 while processing, 10/h). Adding Claude later = `adapters/anthropic.py` + `ADAPTERS` entry +
  catalog rows + `ANTHROPIC_API_KEY` (or an admin key); an OpenAI-compatible provider = catalog
  rows only.
- **08d embed + deploy target — done (branch `feat/ARC-08d-embed-deploy`):** v1 chunking, 768-dim
  embeddings through the AI layer (`catalog.EMBEDDING`), chunks + `done` in one guarded
  transaction, `processing_done`; image built from the repo root with the runtime prompt; worker
  heartbeat health check; `app/api/deploy/compose.example.yml` (API + worker, worker env only
  `DATABASE_URL_WORKER`). Regenerate charged like one generation (owner decision 2026-11-03).
- **08e schedulers — done (branch `feat/ARC-08e-schedulers`):** migration `0006`
  (`scheduler_runs` leases, `quota_reconcile_wallets`, `retention_purge_audit`), worker tasks
  `key_health` (24 h), `retention_purge` (24 h), `wallet_reconcile` (5 min), `stuck_meetings`
  (5 min). The v1 wallet reconcile never closed a drift (BUG-021); v2 sets the wallet to the
  ledger sum. v1's stuck-reservation refund is not ported (the runner's stuck sweep refunds).
- ARC-15: sandbox ffmpeg (separate uid, no network, seccomp); `stop_grace_period: 30s`; run the
  ARC-18 file copy before the worker starts.

**Decided 2026-11-02 (owner)**
- Quota dedup keys per job (`gen:<job_id>:reserve|settle|refund`): a requeue / reprocess is
  charged again (v1 keyed by meeting: free re-runs); retries of one job stay idempotent.
- The stuck sweep refunds and logs `processing_failed` like any terminal failure (v1 did not).
- Terminal errors (`PipelineError`: bad file, forged key, unknown step / provider / model,
  provider rejection) are never retried.
- Bounded run time: 12 min per step, 6 h per pipeline run (`payload.started_at`), stuck sweep at
  15 min.
- Key pools are kept per provider and rebuilt only when the key set changes (v1 rebuilt every 30 s).
- One active job per meeting, enforced by a unique index; `process` limited to 30/h per user.
- Video → audio extraction runs in the worker (moved from `/uploaded`); the extracted audio is
  not stored (the Drive file stays the original video).
- Gemini audio transcription / long-audio chunking not ported (dead in v1).
- 08d (2026-11-03): regenerate costs what one generation costs (transcribed seconds), refunded when
  it fails.
- 08c (2026-11-03): design for more AI providers later (Claude etc.): adapter per API kind,
  catalog of providers/models; Claude itself not built yet.
- 08b (2026-11-03): a transcript with no speech fails the meeting with a full refund (spec
  acceptance criterion; v1's job path marked it `done` with "No speech detected").

**Key files**
- 08a: `app/api/app/worker/{runner,start,audio,jobs,errors,backoff,messages,probe,quota,policy,__main__}.py`,
  migration `0005_worker_grants`, `app/api/app/routers/meetings.py` (`process`)
- 08b: `app/api/app/worker/{speechmatics,speechmatics_client,transcribe_poll,steps}.py`
- 08c: `app/api/app/services/ai/{catalog,schema,types,service,prompts,model_lock,analysis}.py`,
  `adapters/{gemini,openai_compat}.py`, `app/api/app/worker/analyse.py`, `routers/meetings.py`
  (`regenerate`)
- 08e: migration `0006_worker_schedulers`, `app/api/app/worker/schedule.py`,
  `app/api/app/worker/tasks/{keyhealth,retention,maintenance}.py`
- 08d: `app/api/app/worker/{chunk,embed,health}.py`, `app/api/Dockerfile` +
  `Dockerfile.dockerignore`, `app/api/deploy/compose.example.yml`, `.github/workflows/ci-api.yml`
- Tests 08a: `test_worker_{backoff,errors,messages,probe,quota,policy,main,audio}.py`,
  `test_worker_runner_integration.py`, `test_worker_grants_integration.py`
- Expected later: `app/api/app/pipeline/**`, `app/api/app/ai/**`, `app/api/app/schedulers/**`

---

### ARC-09 — Chat / RAG API
**Priority:** High | **Status:** ✅ Done

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
- `app/api/app/routers/chat.py`, `app/api/app/rag/{scope,answer}.py`, `app/api/app/services/access.py` (`folder_viewable`); tests `app/api/tests/test_rag.py`, `test_chat_integration.py`

---

### ARC-10 — Admin API
**Priority:** High | **Status:** ✅ Done

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
- `app/api/app/routers/admin/{_common,users,ops,config}.py`, `app/api/app/domain/{admin,admin_ops,admin_config}.py`; tests `app/api/tests/test_admin_*`

---

### ARC-11 — Import Figma Make frontend
**Priority:** High | **Status:** ✅ Done (2026-11-04; foundation + shell + sign-in, screens in ARC-13/14)

**User Story**  
As a developer, I want the Figma Make source turned into a clean `app/web` foundation (routing, tokens, i18n, runtime config, API client, auth flow) so that screens can be wired to the API.

**Context**
Figma Make output is a prototype: mock data, state-based navigation, hard-coded strings. Owner chose Tailwind + shadcn/ui, one design with light/dark, EN + VI.

**Use Cases**
1. Deep link `/meetings/<id>` loads the right screen after sign-in.
2. User switches VI ↔ EN; choice persists.

**Frontend**
- Auth contract from ARC-05 (CLAUDE.md §0.3): access token in memory only; call `/auth/refresh`
  with `credentials: 'include'` on start and on a 401 (retry the request once); serialise
  refreshes across tabs (single-flight + BroadcastChannel) - a second refresh within 10 s gets
  401 without logging out; email links carry `#token=` in the fragment.
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

**Key files**
- `app/web/src/{main.tsx,app/,auth/,api/,i18n/,theme/,lib/config.ts}`, `app/web/Dockerfile`, `app/web/deploy/*`,
  `app/web/scripts/{check-i18n.mjs,gen-api.sh}`, `app/web/design/figma-make/` (reference), `.github/workflows/ci-web.yml`

---

### ARC-12 — Port browser-only logic
**Priority:** High | **Status:** ✅ Done (2026-11-04; Record screen + building blocks; upload cap 500 MB, owner decision). Done check (2 min Chrome recording processed in staging) deferred to ARC-15 staging.

**User Story**  
As a user, I want recording, the recording notice, uploads and audio playback to behave exactly as in v1 inside the new UI.

**Context**
These features have no server equivalent and are not in the Figma Make output: REC-01..05, COM-01, MTD-02, §9j, §9n.

**Use Cases**
1. Start recording → notice → tab + mic mixed → upload to Google Drive (ARC-17) → processing.
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
**Priority:** High | **Status:** ✅ Done (3 PRs: #56, #57, 13c; Playwright core flow EN/VI runs in CI against a local stack — the staging run moves to ARC-15)

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
- From the ARC-05 review: production `JWT_PRIVATE_KEY` generated on the server
  (`scripts.gen_jwt_key --env-file`), `WEB_ORIGIN` = production SPA origin, web and API on sibling
  subdomains served at `/`, SMTP app password of a dedicated account; add gitleaks (pre-commit + CI).

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

### ARC-17 — Google Drive storage backend (replaces R2 in v2)
**Priority:** High | **Status:** ✅ Done — `drive_smoke` PASS on the dev root folder (owner, 2026-11-02)

**User Story**  
As the owner, I want v2 to store meeting audio and avatars in my Google One Drive (5 TB) instead of Cloudflare R2 so that storage uses capacity I already pay for.

**Context**
v1 and ARC-06 store files in R2 (presigned PUT/GET). The owner has a personal Google One 5 TB account and decided (2026-10-29) to move v2 storage there and drop Cloudflare from v2. Trade-offs accepted: a personal account cannot use a service account (OAuth refresh token instead), Drive has no signed URLs (playback is proxied by the home server), and recordings live next to personal data. Rejected: keep R2 (near-zero cost at current volume); R2 for hot files + Drive as archive (less work, but keeps Cloudflare).

**Use Cases**
1. Owner runs `connect_gdrive` once, signs in with Google, and v2 can store files.
2. A user finishes a recording; the browser uploads it straight to Drive; the API verifies it.
3. A user plays a 1-hour meeting and seeks to minute 45 without downloading the whole file.
4. Retention purge / meeting delete removes the file permanently from Drive.

**Frontend**
- Upload: `PUT` to the resumable session URI returned by the API (single request, or 8 MiB chunks in multiples of 256 KiB), then report the returned file id (ARC-12 wires it).
- Playback: `<audio src>` = signed media URL from the API.

**Backend**
- OAuth: owner's Google Cloud project, client type "Desktop app", consent screen External + publishing status **In production** (Testing expires refresh tokens after 7 days), scope `https://www.googleapis.com/auth/drive.file` only. `scripts/connect_gdrive.py` runs a loopback + PKCE flow, creates (or reuses) the root folder, stores client id, client secret and refresh token (AES-256-GCM, `KEY_ENCRYPTION_SECRET`), root folder id and account email in `drive_config`.
- Migration `0003`: `drive_config` (single row) and `storage_objects(key PK, file_id UNIQUE, size_bytes, content_type, md5, created_at)`. Grants: `ricotdin_service` read/write, `ricotdin_worker` read (+ write on `storage_objects`), `ricotdin_app` none.
- `storage/base.py`: a `Storage` protocol (upload_session, confirm_upload, media_url, get_bytes, download_to_file, size, delete, delete_many, check) so ARC-07/08/10 code against it; `platform.storage(conn)` returns `DriveStorage`. `r2.py` remains only as an ARC-18 source reader (removed in ARC-16).
- Access token cached in memory until 60 s before expiry; `invalid_grant` → `StorageNotConfigured` (503) and an error log telling the owner to re-run `connect_gdrive`. HTTP via httpx; no Google SDK.
- Upload session: `POST upload/drive/v3/files?uploadType=resumable` with name = key, parent = root, `appProperties.key`, `X-Upload-Content-Type`, `X-Upload-Content-Length`, `Origin: WEB_ORIGIN`. Media types and size caps as in ARC-06. The session URI is a bearer secret: never logged, returned once.
- Confirm: `files.get` on the reported id; accept only if `appProperties.key`, parent, size (= declared, ≤ cap) and MIME type match; otherwise delete it and answer 422. Upsert `storage_objects`; a replaced file id is deleted.
- Media: `media_url(key)` → `/media?t=<token>`. The token is HMAC-SHA256 over (key, expiry ≤ 15 min), key derived by HKDF from `KEY_ENCRYPTION_SECRET` (no new env var). The route checks the token before any Drive call, forwards `Range` to `alt=media`, returns 200/206 with `Content-Range`, `Accept-Ranges: bytes`, `Content-Type` from the map, `Cache-Control: private, max-age=0`; at most 8 concurrent streams per process (503 beyond).
- Delete: `files.delete` (permanent, no trash), then the map row; 404 counts as deleted.
- Retry: 429, 403 `rateLimitExceeded`/`userRateLimitExceeded` and 5xx with exponential backoff + jitter, max 5 attempts, then `StorageError` (503).
- `check()`: token refresh works, root folder exists, `permissions.list` on root returns only the owner (otherwise `shared_root`), plus `about.storageQuota` for admin usage.

**Acceptance Criteria**
- Given no `drive_config` row or a revoked refresh token, when any storage call runs, then it raises `StorageNotConfigured` (503) and no token or secret appears in logs.
- Given an upload session for `<uid>/<mid>.webm`, when the reported file id has a different `appProperties.key`, parent, size or MIME type, then the call answers 422; the file is deleted only if that key's session created it in the root (never another key's file, a folder or the root); a matching file gets a `storage_objects` row, and a key that is already mapped answers 409 (review round 1).
- Given a valid media URL, when it is requested with `Range: bytes=1000-1999`, then the answer is 206 with `Content-Range: bytes 1000-1999/<size>` and exactly those bytes; an expired or tampered token answers 403 without a Drive call.
- Given a stored key, when `delete` runs twice, then the file is gone from Drive (not in trash), the map row is gone and the second call is a no-op.
- Given Drive answers 429 four times then 200, when a call runs, then it succeeds; after 5 failures it raises `StorageError`.
- Given the root folder has a permission for anyone other than the owner, when `check()` runs, then it reports `shared_root`.

**Test Plan**
- Pure logic in `app/api/app/services/storage/drive_rules.py`: `verify_uploaded_file()`, `parse_range()`, `is_retryable()`, `retry_delay()`, `root_is_private()`; `media_token.py`: `sign_media_token()` / `verify_media_token(now=...)`.
- Tests: `app/api/tests/test_drive_rules.py`, `test_media_token.py` (pure); `test_drive_storage.py` with `httpx.MockTransport` as a fake Drive (session, confirm, range, delete, retry, revoked token); `test_drive_storage_integration.py` for migration 0003 grants (app role cannot read `drive_config` / `storage_objects`).

**Structural flags**
- New provider (Google Drive API) and OAuth secrets → SEC review.
- Migration `0003` (two tables + grants).
- New public route `/media` (token-authorised, no session).
- >10 files; CLAUDE.md §0.4 rewritten for Drive.

**Done check**
- `cd app/api && uv run pytest -q` green, and `uv run --env-file .env python -m scripts.drive_smoke` uploads a test file through a session, range-reads it via `/media`, deletes it and reports `check()` OK on the dev root folder.

**Out of scope**
- "Connect Google Drive" button on `/admin/storage` (follow-up after ARC-14).
- Copying v1 files (ARC-18). v1 keeps R2 until cutover.
- DB backups (OPS-03 stays on its own R2 bucket).
- Server-side audio cache, multiple Drive accounts, restoring from Drive trash.

**Key files (expected)**
- `app/api/app/services/storage/{base,gdrive,drive_rules,drive_oauth,media_token,config}.py`, `app/api/app/services/platform.py`
- `app/api/app/routers/media.py`, `app/api/app/main.py`, `app/api/app/core/{logging,redact}.py`
- `app/api/scripts/connect_gdrive.py`, `app/api/scripts/drive_smoke.py`
- `app/api/migrations/versions/0003_drive_storage.py`, `app/api/migrations/sql/0003_drive_storage{,_down}.sql`
- Tests: `test_drive_rules.py`, `test_media_token.py`, `test_drive_oauth.py`, `test_drive_storage.py` (+ `fake_drive.py`), `test_media_route.py`, `test_drive_storage_integration.py`
- Tests listed above; `CLAUDE.md` §0.4

---

### ARC-18 — Migration copies files to Google Drive
**Priority:** High | **Status:** ❌ Not started

**User Story**  
As the owner, I want the v1 → v2 migration to copy every audio file and avatar (v1 R2 bucket and legacy Supabase Storage) into Google Drive so that no file is lost at cutover.

**Context**
ARC-03 copies only legacy Supabase Storage objects into R2 and assumes R2 files stay in place. With ARC-17, v2 reads only Drive, so every object from both v1 sources must move. Rejected: keeping a dual-read R2 fallback in v2 (keeps Cloudflare, two code paths).

**Use Cases**
1. Rehearsal: the owner copies all files into a separate `ricotdin-rehearsal` Drive folder and gets a PASS report.
2. Final run (ARC-15): files land in the production root folder; a re-run copies nothing.

**Frontend**
- n/a.

**Backend**
- For every `meetings.audio_path` and avatar key: ownership check (`is_owned_audio_key` / `is_owned_avatar_key`); source chosen by the row's storage provider (Supabase Storage, or the v1 R2 bucket with credentials decrypted from v1 `storage_config`); stream to a temp file with `max_bytes`; upload via DriveStorage server-side into the target folder; verify size + md5; upsert `storage_objects`.
- Skip when a `storage_objects` row with the same size + md5 exists (idempotent). Source is never written or deleted.
- Flags: `--confirm-drive-folder <id>` must equal the folder in the target's `drive_config`, replacing `--r2-bucket`; `--skip-storage` kept.
- Report: copied / skipped / rejected (ownership) / failed counts and an order-independent digest of (key, size, md5); no row values or messages from Drive.
- Runbook `docs/ops/v2-migration-rehearsal.md` rewritten: rehearsal folder via `connect_gdrive --folder ricotdin-rehearsal` on the rehearsal branch, deleted afterwards.

**Acceptance Criteria**
- Given one meeting whose audio is in the v1 R2 bucket and one in Supabase Storage, when the script runs, then both exist in the target Drive folder with matching size and md5 and a `storage_objects` row.
- Given a completed run, when the same command runs again, then nothing is uploaded and the report PASSes.
- Given a row whose key fails the ownership check, when the script runs, then it is not copied and is counted as rejected.
- Given `--confirm-drive-folder` that differs from the target's `drive_config` folder, when the script starts, then it exits 2 before copying.
- The source R2 bucket and Supabase Storage receive no write or delete calls.

**Test Plan**
- Pure logic: `app/api/app/migration/storage_plan.py` → `plan_object_copies(rows, existing_map)` (copy / skip / reject), `storage_digest()`.
- Tests: `app/api/tests/test_migration_storage.py`; source/target fakes for the run loop (no network).

**Structural flags**
- Reads v1 R2 credentials (secrets) → SEC review of logging. No new migration.

**Done check**
- Two rehearsals with a PASS report including storage, logged in `docs/ops/v2-migration-rehearsal.md` (this also closes ARC-03).

**Out of scope**
- Deleting the v1 R2 buckets and the Supabase bucket (ARC-16, after a stable period).

**Key files (expected)**
- `app/api/scripts/migrate_from_supabase.py`, `app/api/app/migration/{plan,report,storage_plan}.py`
- `app/api/tests/test_migration_storage.py`, `docs/ops/v2-migration-rehearsal.md`

---

## Build Order

ARC-00 → ARC-01 → ARC-02 → ARC-04 → ARC-03 → ARC-05 → ARC-06 → ARC-17 → ARC-07 → ARC-08 → ARC-09 → ARC-10 →
ARC-11 → ARC-12 → ARC-13 → ARC-14 → ARC-18 → ARC-15 → ARC-16.
ARC-11/12 may start once ARC-05 OpenAPI is frozen (parallel to ARC-07..10).
ARC-17 (Google Drive storage, owner 2026-10-29) comes before ARC-07/08/10/12, which use storage;
ARC-18 needs ARC-03 + ARC-17, and the ARC-03 rehearsals run after it.

## Dependencies

**Depends on:** all `[x]` features (they define v2 parity).  
**Blocks:** every `[ ]` feature (built on v2 after ARC-15).
