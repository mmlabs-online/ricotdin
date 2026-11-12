# Profile & Settings Module (PRF)

**Module prefix:** PRF  
**Status:** ❌ Not started  
**Priority:** Medium (PRF-01 to PRF-05 are foundational), Low (PRF-06 to PRF-13 are deferred)

---

## Overview

The Profile & Settings module gives users visibility into and control over their account — identity, security, preferences, and data. PRF-01 is the container page for all sub-settings; most other features depend on it. Features in this module interact closely with AUT (auth), COM-05 (sharing), ADM (admin management), and OBS (activity log). Defer heavy items (2FA, sessions, data export) until the security and compliance phases.

---

## Features

### PRF-01 — Profile page & account info
**Status:** ❌ Not started

**User Story**  
As a user, I want a single profile/settings page showing my account info (email, role, join date, meeting count) so I can see my account at a glance.

**Use Cases**
1. User navigates to `/profile` (or `/settings`).
2. Page displays: email, username, role badge, join date, meeting count.
3. All fields are read-only on this overview; sub-sections below handle edits.

**Frontend**
- Route: `/profile` (or `/settings`).
- Sections: Account Info, Edit Identity (PRF-02), Security (PRF-03/PRF-12), Preferences (PRF-05/PRF-06/PRF-07/PRF-08).
- Meeting count reuses the ADM-01 computation (query `meetings` for the current user).

**Backend**
- `GET /api/profile` — returns `{ email, username, role, created_at, meeting_count }`.
- Reads from `profiles` + count from `meetings` using the user's own session (RLS-scoped).

**Depends on:** AUT-01

---

### PRF-02 — Edit display name & username
**Status:** ❌ Not started

**User Story**  
As a user, I want to edit my display name and username so my identity is correct across the app and in shared folders.

**Use Cases**
1. User opens the profile page, navigates to the "Edit Identity" section.
2. Edits username (with uniqueness check) and/or display name.
3. Submits → server validates uniqueness, updates `profiles`.
4. New username is reflected everywhere (share lists, meeting owners).

**Frontend**
- Inline edit form inside PRF-01 page.
- Real-time uniqueness feedback (debounced check against server).
- Save / Cancel actions; success toast on save.

**Backend**
- `PATCH /api/profile` — accepts `{ username?, display_name? }`.
- Username uniqueness validation: matches sign-up rules (AUT-01).
- Column-level privilege already enforces this is user-self-service only.

**Depends on:** PRF-01

**Note:** Username uniqueness must match sign-up rules (AUT-01); surfaces in COM-05 share lists.

---

### PRF-03 — Change password
**Status:** ❌ Not started

**User Story**  
As a user, I want to change my password (confirming the current one) so I can keep my account secure.

**Use Cases**
1. User navigates to the Security section of the profile page.
2. Enters current password, new password, confirm new password.
3. Server re-authenticates with current password, then updates via Supabase auth.
4. On success, session remains valid; confirmation shown.

**Frontend**
- Password change form within PRF-01 page.
- Validation: min 8 chars; new ≠ current.

**Backend**
- `POST /api/profile/change-password` — `{ currentPassword, newPassword }`.
- Re-auth: `signInWithPassword(email, currentPassword)` to verify before update.
- Update: `auth.updateUser({ password: newPassword })` with the user's session.
- Never expose auth secrets client-side.

**Depends on:** AUT-01

**Note:** Pairs with SEC-01/SEC-02; never expose auth secrets client-side.

---

### PRF-04 — Avatar upload
**Status:** ❌ Not started

**User Story**  
As a user, I want to upload a profile avatar (or use generated initials) so my account is visually identifiable.

**Use Cases**
1. User uploads an image (JPEG/PNG/WebP, max 2 MB) from the profile page.
2. Server validates type + size, stores in Storage (bucket `avatars`), updates `profiles.avatar_url`.
3. Fallback: generated initials / identicon when `avatar_url` is null.
4. Avatar shown in the nav header and share lists.

**Frontend**
- Avatar component with upload trigger; preview before save; remove/reset option.
- Shows initials-based fallback when no avatar is set.

**Backend**
- `POST /api/profile/avatar` — multipart; validates image MIME + size cap.
- Upload via signed URL to `avatars` bucket; update `profiles.avatar_url`.
- Reuses CST-02 signed-URL pattern; enforce image type + size (no video/audio).

**Depends on:** PRF-01, CST-02

**Note:** Reuses CST-02 signed-URL upload/download; enforce image type + size cap.

---

### PRF-05 — Theme configuration
**Status:** ❌ Not started

**User Story**  
As a user, I want to switch between light/dark theme (and accent) so the UI matches my preference.

**Use Cases**
1. User selects a theme (Light / Dark / System) from the Preferences section.
2. Preference is saved to `profiles.preferences` (jsonb) and applied on load.
3. Accent colour picker (optional) within admin-defined palette.

**Frontend**
- Theme toggle in profile/settings; also accessible from the nav.
- Reads preference on app boot; applies CSS class / next-themes logic.
- Preference stored in DB (not just localStorage) so it roams across devices.

**Backend**
- `PATCH /api/profile/preferences` — `{ theme?: 'light'|'dark'|'system', accent?: string }`.
- Stored in `profiles.preferences` jsonb column.

**Depends on:** PRF-01

**Note:** Frontend-only preference; no pipeline impact.

---

### PRF-06 — Language preference
**Priority:** Medium | **Status:** ✅ Done (v2, 2026-11-12) — migration `0009_profile_locale`; API `app/api/app/routers/profile.py` (preferences), pure `app/domain/rules.py::parse_preferences_patch`; web `app/web/src/i18n/locale.ts::accountLocaleToApply`, `i18n/useAccountLocale.ts` (AppShell + AdminShell apply, header toggle + Profile "Language" section save).

**User Story**  
As a user, I want my UI language (Vietnamese/English) saved on my account so that every device I sign in on speaks my language.

**Context**
v2 already switches EN/VI from the header (AppShell, AuthLayout), but the choice lives in
localStorage per device, so a new device or a cleared browser falls back to the browser language.
Owner decisions 2026-11-12: store it on the account; the account value wins after sign-in; emails
stay bilingual (PRO-01 may use the stored value later). Rejected: closing PRF-06 as covered by the
toggle; single-language emails (bigger scope, not needed for internal use).

**Use Cases**
1. A user picks VI in the header toggle → saved on the device and on the account.
2. The same user signs in on another device (browser in EN) → the UI switches to VI.
3. A user with no saved language signs in → the UI keeps the device/browser language; nothing is saved until they choose.
4. The user changes the language in Profile → Preferences; the UI switches at once.

**Frontend**
- Pure `app/web/src/i18n/locale.ts` → `accountLocaleToApply(account, current)`: returns the locale to switch to, or null (no value / same).
- AppShell: once preferences load, apply the account locale (setLocale, also stored on the device). The header toggle calls setLocale + PATCH `{ locale }` (fire-and-forget; a failure keeps the local choice, no error toast).
- ProfilePage Preferences: a Language select (English / Tiếng Việt) bound to the same value.
- AuthLayout (signed out): unchanged, device only.
- EN/VI strings for the new label.

**Backend**
- Migration `0009_profile_locale`: `profiles.locale text NULL CHECK (locale IN ('en','vi'))`, `GRANT UPDATE (locale) ON profiles TO ricotdin_app`.
- `GET /profile/preferences` adds `locale` (string or null).
- `PATCH /profile/preferences` accepts `locale: 'en'|'vi'|null` via `parse_preferences_patch`; anything else → 422; independent of the model and folder fields.
- Migration script: add `locale` to `V2_ONLY_COLUMNS["profiles"]` (v1 has no such column).

**Acceptance Criteria**
- Given PATCH `{ "locale": "vi" }`, when GET preferences, then `locale` is `"vi"`, and model/folder preferences are unchanged.
- Given PATCH `{ "locale": "fr" }` or a non-string, then 422 and nothing is stored; `{ "locale": null }` clears it.
- Given an account with `locale = "vi"` and a device set to EN, when the signed-in app loads, then the UI renders in VI and `<html lang="vi">`.
- Given an account with no locale, when the app loads, then the device/browser language stays and no PATCH is sent.
- Given a signed-in user clicks the EN toggle, then the UI switches at once and PATCH `{ "locale": "en" }` is sent; a failed PATCH keeps EN locally.
- Given the v1→v2 copy runs again, then `profiles.locale` keeps its value (V2_ONLY_COLUMNS test).

**Test Plan**
- Pure: `app/api/app/domain/rules.py::parse_preferences_patch` (locale cases) → `app/api/tests/test_domain_rules.py`.
- Pure: `app/web/src/i18n/locale.ts::accountLocaleToApply` → `app/web/src/i18n/locale.test.ts`.
- Integration: preferences test (set / clear / 422 / independence) next to the PRF-07 ones.
- `test_migration_transform.py` enforcement test covers the new column; `test_migration_integration.py` asserts it survives a re-run.

**Structural flags**
- New migration `0009_profile_locale` (High tier: Ming merges). No env var, no provider, no RLS policy change (column grant only).

**Done check**
- `cd app/api && uv run pytest -q tests/test_domain_rules.py` + the integration test; `cd app/web && npm run typecheck && npm test`; manual: set VI on one browser, sign in on a second browser in EN → VI.

**Out of scope**
- Single-language emails (PRO-01 may use `profiles.locale`).
- More languages than en/vi.

**Key files (expected)**
- `app/api/migrations/sql/0009_profile_locale{,_down}.sql`, `migrations/versions/0009_profile_locale.py`
- `app/api/app/domain/rules.py`, `app/api/app/routers/profile.py`, `app/api/app/migration/plan.py`
- `app/web/src/i18n/locale.ts`, `app/web/src/app/AppShell.tsx`, `app/web/src/routes/ProfilePage.tsx`, `app/web/src/api/profile.ts`, `app/web/src/i18n/locales/{en,vi}.json`

---

### PRF-07 — Default folder preference
**Status:** ✅ Done (v2, 2026-11-12) — migration `0008_default_folder`; API `app/api/app/routers/profile.py` (preferences), `routers/meetings.py` (`POST /meetings`), pure `app/domain/rules.py::parse_preferences_patch` + `app/domain/uploads.py::choose_meeting_folder`; web `app/web/src/lib/folders/defaultFolder.ts`, `routes/ProfilePage.tsx` (DefaultFolderSection), `routes/RecordPage.tsx` (one folder select for recorder + upload). Owner decisions 2026-11-12: picker at creation on the Record page; editor-shared folders allowed; a default that lost access → no folder, not an error.

**User Story**  
As a user, I want to set a default folder for new meetings so I don't have to pick one every time.

**Use Cases**
1. User selects a default folder from their folder list in the Preferences section.
2. New meetings (both recorded and uploaded) are automatically assigned that folder.
3. User can still override the folder at creation time.

**Frontend**
- Folder dropdown in preferences (loads from `GET /api/folders`).
- "None" option clears the default.

**Backend**
- `PATCH /api/profile/preferences` — `{ default_folder_id?: string|null }`.
- `POST /api/meetings` reads `profiles.preferences.default_folder_id` when no folder is explicitly provided.

**Depends on:** PRF-01, PRO-06

**Note:** Rides along with the folder feature; default still overridable at creation.

---

### PRF-08 — Default AI model preference
**Status:** ✅ Done — delivered by AIP-06 (`profiles.default_provider` / `default_model`, `GET/PATCH /api/profile/preferences` within the admin allow-list)

**User Story**  
As a user, I want to choose my default processing model (Flash ↔ Flash-Lite) so I can trade speed/cost myself.

**Use Cases**
1. User selects their preferred model from the Preferences section.
2. New meetings use that model for processing unless overridden.
3. Admin policy (ADM-10) caps the upper bound; user pref cannot exceed it.

**Frontend**
- Model selector (Flash / Flash-Lite) in preferences.
- Tooltip explaining speed vs. quality trade-off.

**Backend**
- `PATCH /api/profile/preferences` — `{ default_model?: 'flash'|'flash-lite' }`.
- `processMeeting.ts` reads user pref first, then falls back to system default.
- Validate pref against ADM-10 runtime config; reject if above allowed bound.

**Depends on:** PRF-01, ADM-10

**Note:** Must respect ADM-10 runtime config as the upper bound; user pref can't exceed admin policy.

---

### PRF-09 — Account activity log
**Status:** ❌ Not started

**User Story**  
As a user, I want to view my own recent activity (logins, meetings created/deleted, shares granted/received) so I can review what happened on my account.

**Use Cases**
1. User opens the "Activity" section of the profile page.
2. Sees a paginated feed: event type, timestamp, relevant metadata (meeting title, IP).
3. Filtered to the current user's own events only (never other users' data).

**Frontend**
- Paginated activity feed inside PRF-01.
- Same event-type colour badges as the admin activity page.

**Backend**
- `GET /api/profile/activity?page=&perPage=&eventType=` — user-scoped; returns only the caller's own rows from `activity_log`.
- Reads `activity_log` with RLS or explicit `user_id = auth.uid()` filter.

**Depends on:** OBS-02, COM-05

**Note:** Depends on actually recording these events (OBS-02); share events become meaningful once COM-05 lands.

---

### PRF-10 — Notification preferences
**Status:** ❌ Not started

**User Story**  
As a user, I want to manage my notification preferences (e.g. auto-summary email, to-do reminders) so I control what reaches my inbox.

**Use Cases**
1. User opens the "Notifications" section of the profile page.
2. Toggles: auto-summary email after processing (PRO-01), to-do due-date reminders (PRO-03).
3. Preferences saved and respected by the corresponding feature.

**Frontend**
- Toggle list in profile preferences; each toggle disabled with a "Coming soon" badge when the underlying feature is not yet built.

**Backend**
- `PATCH /api/profile/preferences` — `{ notifications?: { summaryEmail?: boolean, todoReminders?: boolean } }`.

**Depends on:** PRF-01, PRO-01, PRO-03

**Note:** Only meaningful once the features it toggles exist (PRO-01 auto-email, PRO-03 reminders).

---

### PRF-11 — Connected sessions / devices
**Status:** ❌ Not started

**User Story**  
As a user, I want to see and sign out my active sessions/devices so I can secure my account if a device is lost.

**Use Cases**
1. User views active sessions list: device type, last seen, IP.
2. User can sign out a specific session or "Sign out all other sessions".

**Frontend**
- Sessions list in the Security section of PRF-01.
- "Sign out" button per session; "Sign out all others" bulk action.

**Backend**
- Relies on Supabase Auth session management (`auth.admin.listUserSessions`, `auth.admin.revokeUserSession`).

**Depends on:** AUT-02

**Note:** Standard security feature; its own effort — defer.

---

### PRF-12 — Two-factor authentication
**Status:** ❌ Not started

**User Story**  
As a user, I want to enable 2FA so my account has an extra layer of protection.

**Use Cases**
1. User enrolls a TOTP authenticator app from the Security section.
2. On subsequent logins, user is prompted for the 6-digit TOTP code.
3. Recovery codes provided at enrollment; option to disable 2FA with re-auth.

**Frontend**
- QR code enrollment flow in profile security section.
- Recovery code download/copy on first setup.

**Backend**
- Supabase Auth MFA (TOTP) enrollment + verification flows.
- `POST /api/auth/mfa/enroll`, `POST /api/auth/mfa/verify`, `DELETE /api/auth/mfa`.

**Depends on:** AUT-02, SEC-02

**Note:** Each a project on its own; defer until security phase.

---

### PRF-13 — Data export & account deletion
**Status:** ❌ Not started

**User Story**  
As a user, I want to export all my data and delete my account (with all traces) so I control my personal data.

**Use Cases**
1. User requests a full data export → receives a ZIP (transcripts, notes, todos, calendar suggestions, chat history as JSON/Markdown).
2. User requests account deletion → confirmation dialog; all rows + Storage files purged; auth user deleted.
3. Export job is async; user receives email when ready (or polls a status endpoint).

**Frontend**
- "Export my data" button → triggers async job, shows status.
- "Delete my account" button → confirmation dialog with explicit acknowledgement text.

**Backend**
- `POST /api/profile/export` — enqueues export job; writes ZIP to temporary Storage path; sends download link.
- `DELETE /api/profile` — mirrors ADM-11 server-side: cleans Storage files, deletes auth user (DB rows cascade).
- User-facing half of ADM-11 — build together, don't duplicate.

**Depends on:** PRV-02, ADM-11

**Note:** User-facing half of ADM-11 — build together, don't duplicate; GDPR-style (NFR-2/NFR-6).
