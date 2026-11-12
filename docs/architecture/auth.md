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
