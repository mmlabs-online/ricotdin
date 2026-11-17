> Moved from CLAUDE.md §0.3 (ARC-19). Rules here are binding.

### 0.3 v2 auth

Since **AUT-05 + AUT-06** (2026-11-16) people sign in only with their **mmlabs account** (§0.3a).
ricotdin's own auth (ARC-05: register / login / refresh / logout / verify / forgot / reset routes,
`/profile/change-password`, `/.well-known/jwks.json`, admin "send reset link", EdDSA JWTs, refresh
cookies, argon2 passwords, SMTP mail, `JWT_PRIVATE_KEY` / `SMTP_*` / `MAIL_FROM` / `REFRESH_TTL_DAYS`)
is **removed**. Migration `0011_wipe_legacy_auth` cleared `users.password_hash`, `refresh_tokens`
and `email_tokens`; the empty tables and the column stay until ARC-16 part 2 removes the v1 migration
tooling that still reads them. The design of the removed code is in git history (before commit `6e8e70a`, AUT-06).

- **Endpoints left:** `GET /auth/me` (`app/routers/auth.py`) — the ricotdin user (id, email,
  username, role) behind the caller's mmlabs token. All other routes use `current_identity` /
  `require_admin` (`app/auth/deps.py`) -> `RequestIdentity` -> `db.app_transaction`.
- **Roles:** only from the mmlabs token (`ricotdin:admin`), mirrored into `users.role` (a trigger
  mirrors `profiles.role`); `PATCH /admin/users/{id}/role` and bulk `set_role` answer 409.
- **Integration tests** (`*_integration.py`) create and drop `ricotdin_test_*` databases on the
  `DATABASE_URL` server; tokens come from `tests/mmlabs_auth.py` (a test ES256 key; test users are
  pre-linked with `mmlabs_sub = 't-' || id`).

### 0.3a Sign in with the mmlabs account (AUT-05, owner decision 2026-11-16)

ricotdin's own sign-in is replaced by the mmlabs identity on org-admin-api (`api.mmlabs.online`).
Contract: org-admin `docs/consumers.md`. AUT-06 removed ricotdin's own auth (§0.3).

- **Browser (`app/web/src/auth/session.ts`, `mmlabs.ts`):** sign-in, sign-up, verify, forgot and
  reset call `{RICOTDIN_AUTH_URL}/api/v1/auth/*` (= `https://api.mmlabs.online`) with
  `credentials: 'include'` and `X-MM-App: ricotdin`. mmlabs keeps the device session (cookie
  `__Host-mm_device`); the chosen account is `localStorage.mm_account_id` (an account session id,
  not a secret). The access token comes from `POST /api/v1/auth/token {audience: "ricotdin",
  account_id}`, lives only in memory, is renewed 60 s before `exp` (15 min) and once on a 401; the
  ricotdin user comes from `GET /auth/me`. `not_member` → "Continue as" (the click is the consent)
  → `POST /api/v1/auth/apps/ricotdin/join`; `email_unverified` → resend screen. Turnstile
  (`RICOTDIN_TURNSTILE_SITE_KEY`, CSP `script-src` + `frame-src challenges.cloudflare.com`) for
  sign-up, forgot-password and sign-in after 3 failures.
- **API (`app/auth/mmlabs.py`, `linking.py`, `deps.py`):** `current_identity` accepts an ES256
  token: keys only from `{MMLABS_ISSUER}/.well-known/jwks.json` (cached ≤ 1 h, unknown `kid`
  refetch ≤ 1/min, a failed refresh keeps the cached keys, no keys at all → 503), `iss` exact,
  `aud == MMLABS_AUDIENCE` as a string, header `typ == at+jwt`, required `exp iat sub jti iss aud`,
  30 s leeway, `email_verified is True`. Never logged.
- **Account mapping:** `users.mmlabs_sub` (migration 0010, unique). First request of an mmlabs
  account: an unlinked user with the same email (case-insensitive) is linked (owner decision), else
  a user + profile is created (`password_hash` NULL, email verified, username from the email local
  part, `-2`, `-3`… on collision; signup quota grant as for registration). An account deleted
  before (`deleted_accounts`, PRF-13) is not re-created from a token issued at or before the
  delete (401 `account_deleted`); a newer sign-in gets a new, empty account without the grant. A user linked to another
  `sub` is never relinked (409 `account_link_conflict`). Concurrent first requests create one user.
- **Role:** `admin` iff the token's `roles` contain `ricotdin:admin`, else `user` (§0.1 R5
  whitelist); `users.role` is written when it differs, so DB functions and `current_admin` agree.
  Changes made in mmlabs apply within the token lifetime (≤ 15 min). `PATCH /admin/users/{id}/role`
  and bulk `set_role` answer 409 `role_managed_externally`. A ricotdin-disabled user gets 403
  `account_disabled` on every request.
- **Settings:** `MMLABS_ISSUER` (default `https://api.mmlabs.online`), `MMLABS_AUDIENCE` (default
  `ricotdin`); web `RICOTDIN_AUTH_URL=https://api.mmlabs.online`, `RICOTDIN_TURNSTILE_SITE_KEY`.
- **Prerequisites at org-admin:** app `ricotdin` registered (`register-app`, origin
  `https://ricotdin.mmlabs.online`, join_policy open); role `ricotdin:admin` assigned to the owner;
  the Turnstile widget lists the hostname `ricotdin.mmlabs.online`.
- **Tests:** `test_mmlabs_token.py`, `test_mmlabs_linking.py`, `test_mmlabs_identity_integration.py`;
  web `auth/session.test.ts`, `auth/mmlabs.test.ts`; the e2e suite signs in through a fake mmlabs in
  `tests/e2e_server.py` (test-only, not in the image).

