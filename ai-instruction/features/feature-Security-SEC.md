# Security Module (SEC)

**Module prefix:** SEC  
**Status:** ❌ Not started — all four are mandatory for production  
**Priority:** Mandatory for any path including internal use

---

## Overview

The Security module addresses the baseline hardening required before the app handles real user accounts and data. Rate limiting prevents brute-force attacks, email verification blocks fake accounts, RLS review audits data isolation, and secret management prevents key leaks.

---

## Features

### SEC-01 — Login rate-limiting
**Status:** ❌ Not started  
**Mandatory:** Yes

**User Story**  
As the system, I want to rate-limit login attempts to prevent brute-force attacks.

**Use Cases**
1. An attacker makes 1000 login requests per minute against `POST /api/auth/login`.
2. After N failed attempts from the same IP (or username), the endpoint returns 429 Too Many Requests.
3. The response includes a `Retry-After` header indicating when the client may retry.
4. Legitimate users experience no throttling during normal use.
5. Rate limit is applied per IP and optionally per username (to block targeted attacks).

**Frontend**
- On 429 response, the login form shows: "Too many attempts. Please try again in X minutes."
- Submit button is disabled during the cooldown.

**Backend**
- Implementation options:
  - **Upstash Redis + `@upstash/ratelimit`** — serverless-compatible, recommended.
  - **In-memory (LRU)** — works for single-instance deployments; resets on restart.
  - **Supabase Auth built-in** — Supabase has some built-in rate limiting; verify if sufficient.
- Limit: e.g., 5 failed attempts per IP per 15 minutes.
- Applies to `POST /api/auth/login` only (registration has lower abuse surface).
- Applies to password reset endpoint too.

---

### SEC-02 — Email verification
**Status:** ❌ Not started  
**Mandatory:** Yes

**User Story**  
As the system, I want email verification at sign-up to ensure real accounts.

**Use Cases**
1. User registers with an email address.
2. A verification email is sent to the address.
3. User must click the verification link before they can access the app.
4. Unverified users who try to log in see: "Please verify your email first. Check your inbox."
5. Resend verification email link available on the login page.

**Frontend**
- After registration: "Check your email for a verification link."
- Login page: shows "Email not verified" error with a "Resend verification email" link.
- Verification success page: "Email verified! You can now log in."

**Backend**
- Supabase Auth has built-in email verification — enable in dashboard: Authentication → Email → "Confirm email" → enabled.
- `POST /api/auth/register` uses `auth.admin.createUser({ email_confirm: false })` by default; Supabase sends the verification email automatically.
- `POST /api/auth/resend-verification` — `auth.admin.generateLink({ type: 'signup' })` to resend.
- Requires SMTP configured in Supabase project settings.
- Depends on: AUT-01 (registration flow).

---

### SEC-03 — RLS review
**Status:** ❌ Not started  
**Mandatory:** Yes

**User Story**  
As an operator, I want a full RLS review to be sure data isolation holds.

**Use Cases**
1. A security-minded developer audits all RLS policies across: `meetings`, `transcript_segments`, `transcript_chunks`, `todos`, `calendar_suggestions`, `chat_sessions`, `chat_messages`, `profiles`, `audit_logs`.
2. For each table, verify:
   - SELECT policy: users can only read their own rows (or all rows if admin).
   - INSERT policy: users can only insert rows with their own `user_id`.
   - UPDATE policy: users can only update their own rows.
   - DELETE policy: users can only delete their own rows.
3. All policies use `auth.jwt()->>'user_role'` (not `user_metadata`) for admin check.
4. Service role key bypasses RLS (intentional for pipeline) — verify it's never exposed to the browser.
5. Penetration test: log in as User A, attempt to query User B's meeting ID directly — should return 0 rows.

**Frontend**
- No UI change.

**Backend**
- Review `migrations/003_rls_owner_or_admin.sql` against the full table list.
- Check that `transcript_chunks` (added for RAG) has RLS applied.
- Check that `audit_logs` has admin-only SELECT.
- Check that `profiles` allows users to read all profiles (for username display) but only update their own username column.
- Document findings in `ai-instruction/security-audit.md`.

---

### SEC-04 — Secret management
**Status:** ❌ Not started  
**Mandatory:** Yes

**User Story**  
As the system, I want proper secret management (no hard-coding) to avoid key leaks.

**Use Cases**
1. No secret values appear in committed code (`.env.local` is in `.gitignore`).
2. All secrets are injected via environment variables at runtime.
3. `NEXT_PUBLIC_*` variables only contain non-sensitive values (Supabase anon key + URL are public by design).
4. `SUPABASE_SERVICE_ROLE_KEY` and `GEMINI_API_KEY` are never logged, never sent to the client, never included in error messages.
5. Secrets are rotated if a leak is suspected; the app continues to work after rotation by updating env vars.

**Frontend**
- No `NEXT_PUBLIC_*` variable contains a secret.
- Client-side code must not include service role key or Gemini key (TypeScript import guards help).

**Backend**
- `.env.local` in `.gitignore` — verify.
- `scripts/check.ts` (`npm run check`) verifies env vars are set.
- Consider adding a lint rule or CI check that fails if `SUPABASE_SERVICE_ROLE_KEY` or `GEMINI_API_KEY` appears in any `NEXT_PUBLIC_*` variable or in client-side code.
- Production secret storage: Vercel env vars, Railway env vars, or a secrets manager (Vault, 1Password Secrets Automation).

---

### SEC-05 — v2 pre-go-live hardening
**Priority:** High | **Status:** ❌ Not started

**User Story**  
As the owner, I want v2 to close the four security gaps left open before go-live so that nobody can take over an account under someone else's email, keep a stolen session forever, spoof names with invisible characters, or farm chat refunds.

**Context**
CLAUDE.md §0.3, §0.8 and §0.10 list these as open: (1) someone can register a victim's email with their own password; the victim's re-registration gets 409, and if the victim clicks the verify link the attacker owns a verified account; (2) refresh sessions slide 30 days forever; (3) the web hides bidi / zero-width characters in names, but the API stores them; (4) a refused chat answer is refunded although the provider call cost us. Owner decisions 2026-11-09 (issue #75): the verify link sets the password, re-registration re-sends it, 90-day absolute lifetime (sessions already older expire at once), reject (not strip) bad characters in folder + meeting names only, refund only failures on our side. Rejected: replacing the unverified account after 24 h, a 30-day limit, stripping characters silently, a daily refund cap, two codes.

**Use Cases**
1. A victim's email was pre-registered by someone else. The victim registers: the answer is the same as for a new account, and a fresh verify link reaches the victim's inbox. Opening it, the victim sets a password and the account is theirs; the other password no longer works.
2. A user who signed in 90 days ago refreshes: 401, sign in again.
3. A folder owner renames a shared folder with U+202E in the name: the API refuses it with a clear message.
4. A user asks chat questions the provider refuses: each one costs one agent query.

**Frontend**
- `/verify-email`: after the Confirm click, the page asks for a new password (+ confirmation, the same rules as `src/auth/validate.ts`), then posts token + password. Success → sign-in page with a "verified, sign in with your new password" notice. EN + VI strings.
- Folder dialog and meeting rename show a localized "invisible characters are not allowed" error (new error code mapped in `folderErrorKey` / `actionErrorKey`).
- Regenerate `src/api/schema.d.ts`.

**Backend**
- `POST /auth/verify-email {token, password}`: password validated before the token is consumed; in one transaction: consume the token, set the password hash (argon2id), mark verified, revoke every refresh token of the user. Expired / used token → the existing invalid-link answer.
- `POST /auth/register`: an email that belongs to an **unverified** account → no new row; issue a new `verify_email` token for the existing account (voids the previous one) and mail it; answer 201 with the same body as a new registration. The new request's username and password are discarded. Username taken by another account → 409 as today; a **verified** email → 409 as today (owner decision 2026-10-26). Mail sends follow the existing per-address limit (3/h).
- Refresh rotation: a family older than 90 days (`min(created_at)` of the family, DB clock) → outcome `expired` (401, token revoked). New tokens never get `expires_at` beyond family start + 90 days. Pure rule in `app/auth/` (`ABSOLUTE_TTL = 90 days`).
- `parse_folder_name` / `parse_meeting_patch` (and the meeting title on create, if accepted there): reject Unicode bidi controls (U+202A–U+202E, U+2066–U+2069), zero-width and format characters (U+200B–U+200F, U+2060–U+2064, U+FEFF) and C0/C1 controls → 400 (folders) / 422 (meetings) with code `invalid_characters`. Same set as `app/web/src/lib/text.ts`.
- Chat `_answer`: `AIRejected` → reply `ANSWER_ERROR_REPLY`, **no refund** (charge kept, metadata reason `answer_rejected`); every other failure keeps today's refund (retrieval error, `AIUnavailable`, `AIBadOutput`, timeout, cancel).
- Replace the three "Open (owner decision pending)" lines in CLAUDE.md §0.3/§0.8 and the §0.10 bidi follow-up with the new rules.

**Acceptance Criteria**
- Given an unverified account for `a@x.com`, when anyone registers `a@x.com` with a free username, then the answer equals a new registration (201, same body), no second user exists, and the account gets a new verify link (the old one stops working).
- Given a verify link, when it is posted with a valid password, then the account is verified, only the new password signs in, and all its refresh tokens are revoked; when posted without a valid password, then 422 and the token still works.
- Given a refresh family whose first token is 90 days + 1 s old, when it is refreshed, then 401 and the token is revoked; a family 89 days old refreshes and its new token expires no later than day 90.
- Given a folder or meeting name containing U+202E or U+200B, when it is created / renamed, then the API refuses it with `invalid_characters` and nothing is stored; plain Vietnamese names with diacritics are accepted.
- Given a chat question whose answer call raises `AIRejected`, then the user is charged one query and no `agent:<id>:refund` ledger row exists; given `AIUnavailable`, then the refund row exists as today.

**Test Plan**
- Pure logic first:
  - `app/domain/rules.py` → `has_invisible_characters()` + both parsers. Tests in `app/api/tests/test_rules.py`: each blocked code point, Vietnamese text, emoji, whitespace.
  - `app/auth/` refresh rule → `absolute_expiry()` / outcome for an old family. Tests in `app/api/tests/test_refresh_rules.py`.
  - `app/rag/answer.py` (or `chat.py` helper) → `refund_reason(exc)`. Tests in `app/api/tests/test_chat_refund.py`.
- Integration: `app/api/tests/test_auth_integration.py`: register an unverified email, verify with password, refresh after 90 days (DB clock moved by updating `created_at`); `test_chat_integration.py`: refusal charged, unavailable refunded.
- Web: `app/web/src/routes/auth/VerifyEmailPage.test.tsx` (password step, no POST before Confirm), error-key tests for `invalid_characters`; e2e core flow updated for the new verify step.

**Structural flags**
- Auth contract change: `/auth/verify-email` now requires `password` (web + e2e updated in the same PR; v2 is not live yet). No migration, no env var, no new provider. ~12–16 files.

**Done check**
- `cd app/api && uv run pytest -q` and `cd app/web && npm test && npm run e2e` green; manual: register twice with the same unverified email, open the second link, set a password, sign in.

**Out of scope**
- Username bidi check (owner chose folders + meetings only).
- Changing the 409 for a verified email (account enumeration; decided 2026-10-26).
- PRF-11 session list / remote sign-out (builds on the 90-day rule).

**Key files (expected)**
- `app/api/app/routers/auth.py`, `app/api/app/auth/service.py`, `app/api/app/auth/` (refresh rule), `app/api/app/domain/rules.py`, `app/api/app/routers/chat.py`, `app/api/app/email/templates.py`
- `app/web/src/routes/auth/VerifyEmailPage.tsx`, `app/web/src/auth/*`, `app/web/src/lib/*/errors`, `app/web/src/i18n/locales/{en,vi}.json`, `app/web/src/api/schema.d.ts`, `app/web/e2e/core-flow.spec.ts`
- `CLAUDE.md` §0.3, §0.8, §0.10

---

## Implementation Order

1. **SEC-04** (secret management audit) — verify `.gitignore`, scan for leaked secrets in git history with `git-secrets` or `trufflehog`. Low effort, high value.
2. **SEC-01** (rate limiting) — add to login route before launch.
3. **SEC-02** (email verification) — enable in Supabase dashboard + update register flow.
4. **SEC-03** (RLS review) — schedule a dedicated review session; document findings.

## Dependencies

- **SEC-01 depends on:** AUT-02 (login endpoint)
- **SEC-02 depends on:** AUT-01 (registration)
- **SEC-03 depends on:** AUT-03, AUT-04 (RLS is already applied; this is an audit)
- **SEC-04 depends on:** nothing; should be done first
