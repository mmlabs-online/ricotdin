# Admin Module (ADM)

**Module prefix:** ADM  
**Status:** Partially done — ADM-01 through ADM-04 ✅ Done (Phases 9, 10a). ADM-05 through ADM-11 ❌ Not started.  
**Key files:** `app/(routes)/admin/`, `app/(routes)/admin/pipeline/`, `app/api/admin/users/`, `app/api/admin/pipeline/`, `lib/admin/guards.ts`, `lib/admin/audit.ts`, `migrations/005_audit_logs.sql`

---

## Overview

The Admin module provides system operators with tools to manage users, monitor the processing pipeline, and (planned) track costs, storage, configuration, and audit logs. All admin routes are server-enforced with `requireAdmin()` — a non-admin request receives 403.

---

## Features

### ADM-01 — User list
**Status:** ✅ Done

**User Story**  
As an admin, I want to view/search/paginate the user list to administer the system.

**Use Cases**
1. Admin navigates to `/admin`.
2. Page loads the user list via `GET /api/admin/users`.
3. List shows: email, username, role badge, disabled status, meeting count, last sign-in date, created date.
4. Admin searches by email or username (client-side filter on the fetched list).
5. Admin paginates (20 rows per page, client-side).
6. Admin's own row shows a "You" badge; self-action buttons are disabled.

**Frontend**
- `/admin` page with a data table.
- Search input filters rows client-side.
- Pagination controls at the bottom.
- "You" badge on the current admin's row.
- Per-row action buttons: Change Role, Enable/Disable, Reset Password, Delete.

**Backend**
- `GET /api/admin/users?page&perPage&search` — fetches up to 1000 users via `auth.admin.listUsers()`.
- Joins `profiles` for username + meeting counts.
- Search + pagination applied server-side (filtered in JS before responding).
- `requireAdmin()` check before any processing.

---

### ADM-02 — Account management
**Status:** ✅ Done

**User Story**  
As an admin, I want to change roles, disable/enable, reset password, and delete users to manage account lifecycle.

**Use Cases**

**Change role:**
1. Admin clicks role badge → dropdown: User / Admin.
2. `PATCH /api/admin/users/:id/role { role }` → updates `auth.users.app_metadata.role` AND `profiles.role`.
3. Optimistic UI update; reverts on error.
4. Target user's role takes effect on their next token refresh.

**Disable/Enable:**
1. Admin clicks Disable/Enable toggle.
2. `PATCH /api/admin/users/:id/status { disabled: boolean }`.
3. Disable: sets `ban_duration = '876600h'` (100 years) via Admin API.
4. Enable: sets `ban_duration = 'none'`.

**Reset password:**
1. Admin clicks Reset Password → confirmation dialog.
2. `POST /api/admin/users/:id/reset-password` → `auth.admin.generateLink({ type: 'recovery' })`.
3. Recovery email sent to the user's email (requires SMTP configured in Supabase).

**Delete user:**
1. Admin clicks Delete → confirmation dialog.
2. `DELETE /api/admin/users/:id` → gathers all `audio_path` from user's meetings → deletes Storage objects → `auth.admin.deleteUser(id)` → all DB rows cascade.

**Frontend**
- Role badge: clickable dropdown with User/Admin options.
- Enable/Disable: toggle switch or button.
- Reset Password + Delete: confirmation dialogs with clear warning text.
- All mutations are optimistic with revert on error.

**Backend**
- All routes guarded by `requireAdmin()`.
- Role sync: every role change updates BOTH `app_metadata` and `profiles.role`.
- Storage cleanup before user delete: best-effort (failures logged as `storageWarnings[]`).

---

### ADM-03 — Safety constraints
**Status:** ✅ Done

**User Story**  
As an admin, I want to be blocked from demoting/locking/deleting myself and deleting the last admin so I can't lock the system out.

**Use Cases**
1. Admin tries to demote, disable, or delete themselves → 400 error: "Cannot perform this action on your own account."
2. Admin tries to demote or disable the last admin → 400 error: "Cannot remove the last admin."
3. Self-action buttons are disabled in the UI (the server still enforces it as defence-in-depth).
4. Admin count is read from `profiles WHERE role = 'admin'` before any demotion/disable/delete.

**Frontend**
- Self-row: role dropdown, disable toggle, delete button are all disabled (grayed out) with tooltip.
- Error banners shown for any constraint violation.

**Backend**
- `lib/admin/guards.ts` — pure functions:
  - `checkAdminRole(appMetadata)` — returns false → HTTP 403 for non-admins.
  - `isSelf(actorId, targetId)` — blocks self-actions.
  - `isLastAdmin(adminCount)` — blocks last-admin removal.
- 21 unit tests in `tests/admin-guards.test.ts`.

---

### ADM-04 — Pipeline & job monitoring
**Status:** ✅ Done

**User Story**  
As an admin, I want a pipeline dashboard to operate without inspecting the DB by hand.

**Use Cases**
1. Admin navigates to `/admin/pipeline`.
2. Status tiles show counts: Pending, Processing, Stuck (processing > 15 min), Failed, Done + avg processing time.
3. Clicking a tile filters the jobs table to that status.
4. Jobs table shows: status badge, meeting title/id, owner email/username, created date (GMT+7), duration, error snippet.
5. Each failed/stuck row has a **Requeue** button.
6. "Requeue all stuck/failed" bulk button with confirmation dialog.
7. Page auto-polls every 10 seconds.

**Frontend**
- `/admin/pipeline` page.
- Status tiles (click to filter).
- Filter tabs + sortable jobs table.
- Requeue button per failed/stuck row (disabled for pending/done).
- Bulk requeue button with confirmation.
- 10-second interval auto-poll.
- Sub-navigation: Users | Pipeline.

**Backend**
- `GET /api/admin/pipeline/overview` — aggregate counts + avg processing secs. Computed in JS from service-role query (no RLS). Stuck = `processing AND updated_at < now() - 15 min`.
- `GET /api/admin/pipeline/jobs?status=&page=&perPage=` — metadata-only list (NO transcript/notes content). Includes owner email/username via join with `profiles` + `auth.users`.
- `POST /api/admin/pipeline/:id/requeue` — safe re-run:
  1. Verify status is `failed` or `processing`.
  2. Delete `transcript_segments`, `todos`, `calendar_suggestions` (transcript_chunks cascade).
  3. Reset `meetings.status='pending'` + clear `error_message/summary/notes/language`.
  4. Write audit log entry: `meeting.requeue`.
  5. Fire `processMeeting()` non-awaited.
  - Returns 422 for `pending`/`done` meetings.
- Audit log: `lib/admin/audit.ts` → `writeAuditLog()` (fire-and-forget).
- Migration 005 required for `audit_logs` table.

---

### ADM-05 — Cost & AI quota monitoring
**Status:** ❌ Not started

**User Story**  
As an admin, I want to track daily Gemini calls, 429/503 error rate, token consumption, and storage usage vs. limits (with near-limit alerts) to know when to enable billing or clean up audio.

**Use Cases**
1. Admin views a dashboard showing: Gemini API calls today, 429 error rate, estimated token usage, Supabase Storage used vs. 1GB cap.
2. Near-limit alerts appear when storage > 80% or API error rate > threshold.
3. Admin can drill into per-meeting token usage.

**Frontend**
- Metrics tiles at `/admin/usage` (or a tab on `/admin/pipeline`).
- Trend charts (daily call count, error rate).
- Alert banners for near-limit conditions.

**Backend**
- Requires instrumenting the Gemini service layer to log call metadata.
- Storage usage: Supabase Storage management API.
- Depends on: CST-01 (cost model), PRP-03 (Gemini calls logged).

---

### ADM-06 — Storage management
**Status:** ❌ Not started

**User Story**  
As an admin, I want to see total audio usage, orphaned files, and bulk cleanup tools to avoid hitting the 1GB cap.

**Use Cases**
1. Admin views total audio usage in MB/GB.
2. Admin sees a list of orphaned files (in Storage but no corresponding `meetings` row).
3. Admin can bulk-delete audio files older than N days.
4. Cleanup confirms how many bytes were freed.

**Frontend**
- Storage management tab at `/admin`.
- File list with size, meeting reference, and age.
- Bulk cleanup with policy selection.

**Backend**
- Cross-reference Supabase Storage object list with `meetings.audio_path` values.
- Bulk delete API with dry-run mode.
- Depends on: PRP-01, MMG-04.

---

### ADM-07 — Audit log
**Status:** ⚠️ Partial (table + write helper done; viewer UI not started)

**User Story**  
As an admin, I want sensitive actions logged to trace incidents and prevent abuse.

**Use Cases**
1. Sensitive actions (role change, user delete, meeting requeue, admin login) are automatically written to `audit_logs`.
2. Admin views a paginated audit log at `/admin/audit`.
3. Admin can filter by actor, action type, date range.
4. Log entries show: actor email, action, target type/id, metadata (before/after), IP, user agent, timestamp.

**What's done:**
- `migrations/005_audit_logs.sql` — `audit_logs` table with 4 indexes. RLS: admin SELECT only; writes via service role.
- `lib/admin/audit.ts` — `writeAuditLog()` fire-and-forget helper + `requestContext()` IP/UA extractor.
- `meeting.requeue` action is logged (ADM-04).

**What's missing:**
- Audit log viewer UI at `/admin/audit`.
- Log entries for role changes, user deletes, user creates, admin logins.

**Backend (existing)**
- `audit_logs` table: `id, actor_id, actor_email, action, target_type, target_id, metadata jsonb, ip_address, user_agent, created_at`.
- `GET /api/admin/audit?page&perPage&actor&action&from&to` — to be built.

---

### ADM-08 — System health
**Status:** ❌ Not started

**User Story**  
As an admin, I want a system-status page showing error rate, uptime, and Supabase/Gemini health.

**Use Cases**
1. Admin views `/admin/health` with: app error rate, Supabase connectivity, Gemini API status, uptime percentage.
2. Automated alerts when any component is unhealthy.

**Depends on:** OBS-01 (Sentry), OBS-03 (uptime monitoring).

---

### ADM-09 — Extended user management
**Status:** ❌ Not started

**User Story**  
As an admin, I want to invite users by email, view per-user usage, do bulk actions, and filter by status/role.

**Depends on:** ADM-01, ADM-02.

---

### ADM-10 — Config & feature flags
**Status:** ❌ Not started

**User Story**  
As an admin, I want to change runtime config (model, audio retention, sign-up toggle) without a deploy.

**Depends on:** PRP-07.

---

### ADM-11 — Data control & privacy
**Status:** ✅ Done

**User Story**  
As an admin, I want to export or erase all of a user's data on request so that we can answer privacy requests.

**Context**
Re-specced 2026-11-17 (owner Q&A), built together with PRF-13 (the user-facing half). Admins could already delete a user (Drive files first, then every row) and the audio retention purge (PRV-02) exists. Chosen: an immediate ZIP export (no job / email), self-service deletion of the ricotdin account, and an admin export of one user. Rejected: exporting audio (large, needs a background job), whole-meeting retention.

**ZIP contents** (`app/api/app/domain/export.py`, pure)
- `README.txt`; `profile.json` (profile, preferences, quota balance); `meetings/<date>-<slug>-<id8>/meeting.md` + `meeting.json` for each meeting the user **owns** (title, dates, summary, notes, to-dos, calendar suggestions, transcript with speaker names); `chats.json` (the user's chat sessions and messages); `activity.json` (own activity, PRF-09). No audio, no meetings owned by others.

**Backend**
- `GET /profile/export` → `ricotdin-export-<username>-<date>.zip` (3 / hour / user; audit `user.export_self`).
- `DELETE /profile {confirm: "<username>"}` → deletes the caller's ricotdin account like the admin delete (shared service: Drive files first, rows cascade, storage warnings returned; audit `user.delete_self`). The mmlabs account stays; signing in again creates a new, empty ricotdin account.
- `GET /admin/users/{id}/export` → the same ZIP for an admin (audit `user.export`).

**Frontend**
- Profile "Your data" section: "Download my data" (file download) and "Delete my Ricotdin account" (dialog: type the username; explains what goes and that the mmlabs account stays); after delete the app signs out of ricotdin.
- Admin user detail: "Export data" action.

**Acceptance Criteria**
- Given a user with meetings, chats and a shared folder, when they export, then the ZIP holds their own meetings (MD + JSON, names applied), chats, activity and profile — never another user's meeting or audio.
- Given `DELETE /profile` with the wrong / missing username → 400; with the right one → every owned meeting audio and the avatar are deleted from Drive, all their rows are gone, others' meetings in their folders stay (uncategorized), an audit row is written.
- Given an admin, then `GET /admin/users/{id}/export` returns that user's ZIP and is audited; a non-admin gets 403.
- Exports are limited to 3 / hour / user (429).

**Test Plan**
- Pure: `app/api/tests/test_export.py` — slug / folder names, meeting Markdown, JSON shapes, README.
- Integration: `app/api/tests/test_export_integration.py` — ZIP contents and isolation, self delete (wrong / right confirm, Drive files deleted via the fake Drive), admin export + audit + 403, rate limit.
- Web: dialog confirm logic test; e2e: download + delete in the core flow if practical.

**Structural flags**
- Migration `0015_deleted_accounts` (review: tombstone = sha256 of the mmlabs sub + when; no second signup grant, tokens from before the delete refused); 3 new routes; the admin delete logic moves into a shared service.

**Done check**
- api + web commands of §0 green; on production, download the export and open a meeting's `meeting.md`.

**Out of scope**
- Exporting audio; whole-meeting retention; deleting the mmlabs account.

---

### ADM-12 — Key model check
**Status:** ✅ Done

**User Story**  
As an admin, I want the key health check to tell me which allowed models each key can actually call so that I see a broken model before users hit `NoUsableKeys`.

**Context**
Before ADM-12 the check proved only that a key authenticates (OpenAI, Anthropic: `GET /models`; Gemini, Grok: one token with one fixed model). A key could be "healthy" and still fail for the model users picked (no access, out of credits). Owner decisions 2026-11-19: probe only the models allowed in `/admin` → AI models (not the whole catalog); no warning in the AI models section.

**Design** (`app/api/app/worker/tasks/keyhealth.py`)
- The key check is unchanged. Only a **healthy** key is then asked for one token (`max_tokens` / `maxOutputTokens` = 1, prompt `ping`) with each allowed model of its provider (`app_settings['generation.allowed_models']`), in allow-list order. A retired model is called as its replacement (`catalog.api_model`); one call answers both.
- Result per model: 2xx → `ok`; error code `model_not_found` / `insufficient_quota` / `not_found_error` / `permission_error`, or 401/403/404 → `unavailable`; other 429 → `limited`; anything else / network → `unknown`.
- Stored in `admin_config.health_models jsonb` (migration 0016; worker gets column UPDATE). NULL = not checked (key failed its check, or Speechmatics). Same daily worker run and `POST /admin/keys/healthcheck`; keys never in a URL, bodies never stored or logged (only the error code is read).

**Frontend**
- `/admin/keys`: under each key, "Allowed models this key can call:" with a badge per model (works / rate-limited / not available / inconclusive), or "No allowed models for this provider."

**Acceptance Criteria**
- Given an allowed OpenAI model the key cannot use (404 `model_not_found`), when the check runs, then that model shows `unavailable` and the others `ok`.
- Given a key that fails its check (401), then no model calls are made and `health_models` is NULL.
- Given `gemini-2.5-flash` and `gemini-3.8-flash` both allowed, then one model call answers both.
- No probe puts the key in a URL.

**Test Plan**
- Pure: `app/api/tests/test_worker_tasks.py` (models to check, probe shapes per kind, retired model, classification, error code); `app/web/src/lib/admin/config.test.ts` (result parsing, badge kind).
- Integration: `test_worker_tasks_integration.py::test_key_health_records_which_allowed_models_each_key_can_call`; `test_worker_grants_integration.py` (worker may update `health_models`).

**Key files:** `keyhealth.py`, `migrations/sql/0016_key_health_models{,_down}.sql`, `app/routers/admin/config.py`, `app/services/keys/guards.py`, `app/web/src/routes/admin/AdminKeysPage.tsx`, `app/web/src/lib/admin/config.ts`.

## Dependencies

- **Depends on:** AUT-03 (role enforcement), PRP-07 (pipeline status)
- **Blocks:** nothing downstream (admin module is a management layer)
