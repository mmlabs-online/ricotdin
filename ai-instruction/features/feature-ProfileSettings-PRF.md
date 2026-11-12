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
**Status:** ❌ Not started

**User Story**  
As a user, I want to choose my UI language (Vietnamese/English) so the app speaks my language.

**Use Cases**
1. User selects a language from the Preferences section.
2. UI re-renders in the selected language on save.

**Frontend**
- Language selector (en / vi) in profile preferences.
- Requires i18n scaffolding (next-intl or similar).

**Backend**
- `PATCH /api/profile/preferences` — `{ locale?: 'en'|'vi' }`.

**Depends on:** PRF-01

**Note:** Larger i18n effort — defer unless i18n scaffolding exists.

---

### PRF-07 — Default folder preference
**Status:** ❌ Not started

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
