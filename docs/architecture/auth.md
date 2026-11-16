> Moved from CLAUDE.md §0.3 (ARC-19). Rules here are binding.

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
  (second tab, retry): 401 without revoking and **without clearing the cookie** (the jar is shared by
  all tabs; ARC-11). Disabled user -> 401 + all tokens revoked. Reset and
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
- **Pre-registration + session lifetime (SEC-05, owner decisions 2026-11-09):** the verify link
  **sets the password** (`POST /auth/verify-email {token, password}`, model `VerifyIn`): password
  checked before the token is touched; the user row is locked before the token row (the order
  `issue_email_token` uses); only an **unverified, enabled** account can be verified (else the
  invalid-link 400, so a stray link is never a 24 h password reset); then token consumed + hash set +
  verified + every refresh token revoked. Registering an email of an **unverified** account creates
  nothing: the password is dropped, a free username replaces the earlier one, one more verify link
  goes to that address **without cancelling earlier links** (an attacker cannot block the owner),
  and the answer equals a new registration (201). Those re-sends have their own silent limit
  (`Limiters.register_resend`, 3/h per address: over it nothing is sent, the answer is unchanged).
  Verified or disabled → 409 (2026-10-26). A username is "taken" only by another account. Refresh:
  **90-day absolute lifetime** per family from sign-in (`tokens.ABSOLUTE_TTL`, family start =
  `min(created_at)`, no migration — never prune rows of a live family) on top of the sliding 30
  days; `refresh_expiry` caps new tokens at the family's day 90.

- **Integration tests** (`*_integration.py`) create and drop `ricotdin_test_*` databases on the
  `DATABASE_URL` branch (never point it at `main`); CI runs them against a `pgvector/pgvector:pg18` service.

### 0.3a Sign in with the mmlabs account (AUT-05, owner decision 2026-11-16)

ricotdin's own sign-in is replaced by the mmlabs identity on org-admin-api (`api.mmlabs.online`).
Contract: org-admin `docs/consumers.md`. The old password / JWT / refresh / email code above stays
only until AUT-06 removes it (both ship in one release).

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
  part, `-2`, `-3`… on collision; signup quota grant as for registration). A user linked to another
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

