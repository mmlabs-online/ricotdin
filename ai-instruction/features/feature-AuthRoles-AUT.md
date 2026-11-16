# Auth & Roles Module (AUT)

**Module prefix:** AUT  
**Status:** ✅ Done (Phase 7)  
**Key files:** `app/api/auth/login/route.ts`, `app/api/auth/register/route.ts`, `lib/auth/server.ts`, `lib/auth/validate.ts`, `migrations/001_profiles.sql`, `migrations/002_jwt_hook.sql`, `migrations/003_rls_owner_or_admin.sql`, `scripts/seed-admin.ts`

---

## Overview

The Auth & Roles module implements secure email+password authentication with username-or-email login flexibility. Two roles (`user`, `admin`) are enforced at multiple layers: JWT claim injection, Row-Level Security, column-level privilege, and a database trigger. Anonymous sign-ins are disabled; the auth flow is fully server-mediated.

---

## Features

### AUT-01 — Sign up
**Status:** ✅ Done

**User Story**  
As a new user, I want to register with email + password + username to create an account.

**Use Cases**
1. User navigates to `/register`.
2. Fills in: email, username, password (min 8 chars, validated client + server).
3. Submits → `POST /api/auth/register`.
4. Server calls `auth.admin.createUser({ email, password, app_metadata: { role: 'user' } })`.
5. A `profiles` row is immediately inserted: `{ id, username, role: 'user' }`.
6. If profile insert fails, the auth user is cleaned up (no orphan auth rows).
7. On success, user is redirected to `/login`.

**Frontend**
- `/register` page with email, username, password fields.
- Client-side validation: email format, username alphanumeric (3–30 chars), password length.
- Inline error messages per field.
- On success, shows a success message + redirect to login.

**Backend**
- `POST /api/auth/register` — uses service role client (`auth.admin.createUser`).
- Role is ALWAYS `'user'` — never read from the request body.
- Username normalized: lowercase, trimmed before insert.
- Duplicate email/username returns a 409 with a user-friendly message.
- `lib/auth/validate.ts` — pure validation functions (24 unit tests).

---

### AUT-02 — Log in
**Status:** ✅ Done

**User Story**  
As a user, I want to log in with email or username for flexible access.

**Use Cases**
1. User navigates to `/login`.
2. Enters email OR username + password.
3. Submits → `POST /api/auth/login`.
4. Server detects if `identifier` contains `@` → treat as email. Otherwise → username lookup.
5. Username lookup: service-role query `profiles WHERE username = normalize(identifier)` → get `id` → `auth.admin.getUserById(id)` → resolve email.
6. `auth.signInWithPassword(resolvedEmail, password)` — returns session tokens.
7. Tokens are set as HTTP-only cookies; user is redirected to `/meetings`.

**Frontend**
- `/login` page with a single "Email or username" field + password field.
- Generic error on failure: "Invalid credentials" (never reveals whether email or username exists).
- On success: redirect to `/meetings` (or the originally requested URL via `next` query param).

**Backend**
- `POST /api/auth/login` — server-side only.
- Username-to-email mapping is NEVER exposed to the client.
- Generic error responses on any failure (prevents username/email enumeration).
- Session cookie: HTTP-only, Secure, SameSite=Lax.

---

### AUT-03 — Role authorization
**Status:** ✅ Done

**User Story**  
As the system, I want to store roles where users can't edit them and enforce at backend + RLS to prevent privilege escalation.

**Use Cases**
1. Role is stored ONLY in `auth.users.app_metadata.role` (writable only via service role).
2. `custom_access_token_hook` (migration 002) copies `app_metadata.role` → `user_role` JWT claim on every token issue.
3. RLS policies read `auth.jwt()->>'user_role'` — no per-query subquery, no user_metadata.
4. Column-level privilege: `REVOKE UPDATE ON profiles FROM authenticated; GRANT UPDATE(username) ON profiles TO authenticated;` — normal users literally cannot UPDATE the `role` column.
5. `prevent_role_escalation` trigger blocks any attempt to change `profiles.role` from the client session.
6. Admin role is seeded via `scripts/seed-admin.ts` (server-side only).

**Frontend**
- UI elements gated by role (e.g., `/admin` link only shown to admins).
- Role is read from the decoded JWT on the client; never from user_metadata.

**Backend**
- `lib/auth/server.ts` — `requireAdmin()` middleware checks `app_metadata.role === 'admin'`.
- All admin API routes call `requireAdmin()` before processing.
- Role changes must update BOTH `app_metadata` (via Admin API) AND `profiles.role`.

---

### AUT-04 — Data isolation
**Status:** ✅ Done

**User Story**  
As a user, I want to access only my own data to ensure privacy.

**Use Cases**
1. All tables (`meetings`, `todos`, `calendar_suggestions`, `transcript_segments`, `transcript_chunks`, `chat_sessions`, `chat_messages`) have RLS enabled.
2. Standard policy: `auth.uid() = user_id OR auth.jwt()->>'user_role' = 'admin'` (owner-or-admin).
3. Browser uses the anon key — all queries are RLS-scoped to the logged-in user.
4. Server pipeline uses the service role key — bypasses RLS for background writes.
5. Admin users can read all rows; normal users can only read their own.

**Frontend**
- Transparent to the user; the server never returns another user's data.
- The anon key is safe to expose in the browser (RLS enforces isolation).

**Backend**
- RLS applied via migration 003 (`003_rls_owner_or_admin.sql`).
- Server pipeline uses `SUPABASE_SERVICE_ROLE_KEY` (env var, never exposed to the browser).
- Admin API routes use service role client but are protected by `requireAdmin()` application-level guard.

---

### AUT-05 — Sign in with mmlabs account
**Priority:** High | **Status:** ✅ Done (code; prod Done check after the release with AUT-06)

**User Story**  
As a user, I want to sign in to ricotdin with my mmlabs account (the one shared by every mmlabs app) so that I use one account everywhere.

**Context**
ricotdin has its own accounts (argon2 passwords, EdDSA JWT, refresh cookie, its own mail). org-admin-api
(`api.mmlabs.online`) now runs the mmlabs identity for every app (email + password, device session
cookie `__Host-mm_device`, per-app ES256 access tokens, JWKS), and already registered app `ricotdin`
(origin `https://ricotdin.mmlabs.online`, join_policy open, role `ricotdin:member`; org-admin USR-07).
Owner decisions 2026-11-16: replace ricotdin's own sign-in entirely; link an existing ricotdin account
by email on first sign-in; ricotdin's admin role comes from the mmlabs role `ricotdin:admin`.
Chosen: the API accepts the mmlabs token directly on every request (one identity source, role and
disable changes apply within 15 min). Rejected: exchanging the mmlabs token once for a ricotdin
session (two session systems, roles stale up to 90 days); waiting for the client libraries
(org-admin USR-08, no date). Contract: org-admin `docs/consumers.md`.

**Use Cases**
1. A new person signs up on ricotdin's page (Turnstile), verifies the email, clicks "Continue as <email>", and lands in ricotdin with an empty account.
2. The owner signs in with an mmlabs account whose email equals their ricotdin account: they see their meetings and the admin area.
3. Someone already signed in to another mmlabs app on this browser sees "Continue as <email>" and enters without typing a password.
4. Staff remove `ricotdin:admin` (or disable the person) in org-admin: within 15 min the admin area (or the whole app) is refused.

**Frontend**
- `/sign-in`: email + password posted to `{authUrl}/api/v1/auth/login` with `X-MM-App: ricotdin`, `credentials: "include"`; Turnstile widget when the API asks for it (after 3 failures). Lists accounts already signed in on this browser (`GET /auth/accounts`) as "Continue as <email>".
- `/register`: `POST /auth/signup` (Turnstile always); then "check your email".
- `/verify-email`, `/reset-password`, `/forgot-password`: same paths as today (the mmlabs links point to them), now calling the mmlabs endpoints (fragment token removed at once, `Referrer-Policy: no-referrer`).
- Session: chosen `account_id` in `localStorage.mm_account_id`; access token from `POST /auth/token {audience: "ricotdin", account_id}` kept in memory only, renewed ~60 s before `exp` and once on a 401; `not_member` + `join_available` → "Continue as <email>" screen → `POST /auth/apps/ricotdin/join` → `/token` again; `email_unverified` → resend screen; sign-out = `POST /auth/logout {account_id}`. The multi-tab broadcast keeps working.
- Profile: change-password section replaced by a link to the forgot-password flow. Admin users page: role control read-only ("managed in mmlabs"); disable/enable stays.
- Config: `authUrl` = `https://api.mmlabs.online` (`RICOTDIN_AUTH_URL`); new `RICOTDIN_TURNSTILE_SITE_KEY`; CSP adds `https://challenges.cloudflare.com` to `script-src` and `frame-src`.

**Backend**
- `app/auth/mmlabs.py`: verify per consumers.md — `ES256` only, keys only from `{issuer}/.well-known/jwks.json` (cache ≤ 1 h, refetch on unknown `kid` at most 1/min, `User-Agent` set), `iss == "https://api.mmlabs.online"`, `aud == "ricotdin"` as a string, required `exp iat sub jti iss aud`, leeway 30 s, header `typ == "at+jwt"`, `email_verified is True`. Uses `PyJWT[crypto]>=2.10.1`. Never logs tokens.
- `current_identity`: verified claims → `resolve_user(sub, email)` → `RequestIdentity(user_id, role)`. `role = "admin"` iff `"ricotdin:admin" in roles`, else `"user"` (whitelist kept, §0.1 R5). Mapping `sub → user_id` cached in-process (immutable once set). `users.role` is written when it differs from the token (DB functions that read it stay right). A ricotdin-disabled user (`disabled_at`) → 403 `account_disabled`.
- `resolve_user`: by `users.mmlabs_sub`; else first sign-in, one transaction as `ricotdin_service`, user row locked: an existing user with the same email (case-insensitive) and no `mmlabs_sub` gets it (and `email_verified_at` if empty); else a new `users` + `profiles` row (`password_hash` NULL) with a username from the email local part (lowercased, only `a-z0-9_-`, padded to 3, cut to 30, `-2`, `-3`… on collision). A user already linked to another `sub` is never relinked (409 `account_link_conflict`).
- Migration: `users.mmlabs_sub text UNIQUE NULL`; `users.password_hash` nullable. Grants per §0.1.
- Admin: `PATCH /admin/users/{id}/role` → 409 `role_managed_externally`. ricotdin's old `/auth/register|login|refresh|…` stop being used by the SPA (removed in AUT-06).
- Settings: `MMLABS_ISSUER` (default `https://api.mmlabs.online`), `MMLABS_AUDIENCE` (default `ricotdin`).

**Acceptance Criteria**
- Given a valid mmlabs token for `aud=ricotdin` with a verified email, when the SPA calls any API route, then it is served as the mapped ricotdin user; a token with another `aud`, `alg`, `typ`, issuer, an expired one, an unknown `kid` or `email_verified=false` gets 401.
- Given a ricotdin account `a@x.com` and an mmlabs account `A@x.com` signing in for the first time, then both share one ricotdin user id (meetings and folders unchanged) and `users.mmlabs_sub` is set; a second, different mmlabs `sub` with that email does not take it over.
- Given an mmlabs account with no ricotdin account, when it first calls the API, then a user + profile with a valid unique username is created.
- Given a token whose `roles` include `ricotdin:admin`, then `/admin/*` is allowed and `users.role = 'admin'`; when the role is removed, the next token (≤ 15 min) is refused on `/admin/*` and `users.role` returns to `user`.
- Given the browser, when a person signs up, verifies, joins and signs in through ricotdin's pages, then they reach `/meetings`; ricotdin's own register/login/refresh endpoints are no longer called (network log).

**Test Plan**
- Pure logic: `app/api/app/auth/mmlabs.py` → `check_header(header)`, `check_claims(claims, now, issuer, audience)`, `role_from_roles(roles)`; `app/api/app/auth/linking.py` → `username_from_email(email, taken)`, `link_decision(by_sub, by_email, sub)`.
- Tests: `app/api/tests/test_mmlabs_token.py` (good token from a test ES256 key + JWKS; each rejection: alg, typ, iss, aud list/other, exp, missing claim, unverified email), `test_mmlabs_linking.py` (username rules + collisions, link/create/conflict decisions), `test_mmlabs_identity_integration.py` (first sign-in links by email, creates, conflict, role mirror, disabled user); web: `app/web/src/auth/mmlabsSession.test.ts` (token renew timing, error-code → screen mapping, account choice).

**Structural flags**
- Auth change: CLAUDE.md §0.1 R5 and §0.3 rewritten (sub → mapped user id; role from token `roles`) → security review.
- Migration (`users.mmlabs_sub`, `password_hash` nullable).
- New provider: api.mmlabs.online (JWKS fetch from the `api` container: check its network reaches the internet; else add the compose `default` network).
- New config: `RICOTDIN_AUTH_URL=https://api.mmlabs.online` and `RICOTDIN_TURNSTILE_SITE_KEY` (web), `MMLABS_ISSUER` / `MMLABS_AUDIENCE` (api, defaults); CSP change. More than 10 files.

**Done check**
- api + web commands of §0 green; then in production (after AUT-06, same release): the owner signs in with the mmlabs account of their email and sees their existing meetings and `/admin`; a fresh mmlabs account signs up, verifies, joins and lands on an empty `/meetings`.

**Out of scope**
- Removing the old auth code, tables and secrets (AUT-06).
- Organizations (org-admin USR-06), join approval (USR-03g), the client libraries (USR-08): switch to them later.
- Account switcher beyond "Continue as"; per-permission checks beyond `ricotdin:admin`.

**Key files**
- `app/api/app/auth/{mmlabs,linking,deps}.py`, `app/api/app/core/settings.py`, `app/api/app/routers/admin/users.py`, migration `0010_mmlabs_identity`, `app/api/tests/e2e_server.py` (fake mmlabs)
- Tests: `test_mmlabs_token.py`, `test_mmlabs_linking.py`, `test_mmlabs_identity_integration.py`, web `auth/session.test.ts`, `auth/mmlabs.test.ts`
- `app/web/src/auth/*` (session, token, AuthProvider), `app/web/src/routes/SignInPage.tsx`, `app/web/src/routes/auth/*`, `app/web/src/routes/ProfilePage.tsx`, admin users page, `app/web/deploy/*` (config, CSP), `app/web/src/i18n/locales/*`
- `docs/architecture/auth.md`, `docs/architecture/db.md`, deployment `apps/ricotdin-v2/` + workflow (web env)

---

### AUT-06 — Remove ricotdin's own auth
**Priority:** High | **Status:** ✅ Done (code; release together with AUT-05)

**User Story**  
As the owner, I want ricotdin's own password, JWT, refresh-token and email code removed once mmlabs sign-in works so that there is one identity system and fewer secrets to guard.

**Context**
Follow-up split from AUT-05 (owner 2026-11-16, option B in two codes): after AUT-05 nothing calls ricotdin's own auth. Keeping it would leave a second way in and two secrets (JWT key, SMTP password) to guard. Released together with AUT-05.

**Backend**
- Delete `/auth/register|login|refresh|logout|verify-email|resend-verification|forgot-password|reset-password`, `/auth/me` (moved to a profile route if the SPA needs it), `/profile/change-password`, `/.well-known/jwks.json`, admin `reset-password`; `app/auth/{jwt,passwords,tokens,cookies,identifier,runtime}.py` parts that only served them; `app/email/*`; rate limiters for them.
- Settings removed: `JWT_PRIVATE_KEY`, `JWT_PREVIOUS_PUBLIC_KEY`, `REFRESH_TTL_DAYS`, `SMTP_*`, `MAIL_FROM`; `scripts/gen_jwt_key.py`.
- Migration: ~~drop `refresh_tokens`, `email_tokens`, `users.password_hash`~~ → owner decision 2026-11-16: `0011_wipe_legacy_auth` NULLs every `password_hash` and deletes all refresh / email tokens; the tables and column stay (the v1 migration tooling still reads them) and are dropped with ARC-16 part 2.

**Frontend**
- Remove the old auth client code paths and their tests.

**Acceptance Criteria**
- Given the API, then the removed routes answer 404 and the app starts without `JWT_PRIVATE_KEY` and SMTP settings.
- Given the deployment repo, then `deploy-ricotdin-v2.yml` no longer requires `RICOTDIN_JWT_PRIVATE_KEY` nor the `org-admin-api` SMTP environment.
- Given the database after `alembic upgrade head`, then no user has a `password_hash` and `refresh_tokens` / `email_tokens` are empty (owner decision 2026-11-16; dropping them moves to ARC-16 part 2).

**Test Plan**
- Delete the tests of removed code; `app/api/tests/test_removed_auth_routes.py` asserts each removed route is gone; `test_legacy_auth_wipe_integration.py` checks migration 0011; integration suites sign in with test mmlabs tokens (`tests/mmlabs_auth.py`).

**Structural flags**
- Data-wiping migration (legacy passwords and sessions cannot come back; no rollback to a release before AUT-05 after it runs); env vars and deployment secrets removed; deployment repo PR.

**Done check**
- api + web commands of §0 green; deploy succeeds without the JWT and SMTP secrets; `curl -i https://ricotdin-api.mmlabs.online/auth/login` → 404.

**Out of scope**
- Anything in AUT-05.

**Key files (expected)**
- `app/api/app/auth/*`, `app/api/app/routers/{auth,profile}.py`, `app/api/app/email/*`, `app/api/app/core/settings.py`, `app/api/migrations/`, `app/api/scripts/gen_jwt_key.py`, `docs/ops/deployment-repo/*`, `docs/architecture/auth.md`

---

## Auth Architecture Summary

```
Browser (anon key)
  ↓ POST /api/auth/login
Server (service role)
  → username lookup (if username login)
  → signInWithPassword
  → HTTP-only session cookie
  ↓ All subsequent requests
Browser sends session cookie
  → Supabase validates JWT
  → custom_access_token_hook injects user_role claim
  → RLS uses auth.jwt()->>'user_role'
```

## Role Enforcement Layers (defence-in-depth)

| Layer | Mechanism |
|---|---|
| JWT source | `app_metadata.role` (service-role-only write) |
| JWT claim | `custom_access_token_hook` → `user_role` |
| Database | RLS policies on all tables |
| Column | `REVOKE UPDATE ON profiles` |
| Trigger | `prevent_role_escalation` |
| Application | `requireAdmin()` in all admin routes |

## Dependencies

- **Depends on:** Supabase Auth + custom access token hook (dashboard config required)
- **Depends on (AUT-05, AUT-06):** mmlabs Identity on org-admin-api (`api.mmlabs.online`: USR-03, USR-03b, USR-03c, USR-04, USR-04b, USR-07, all done); role `ricotdin:admin` and a Turnstile site key (owner).
- **Blocks:** all other modules (auth is the foundation for data access)
