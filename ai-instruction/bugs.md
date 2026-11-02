# Meeting Assistant — Bug Log

> One row per bug. Managed by the `/fix-bug` skill (`.claude/skills/fix-bug/SKILL.md`).
> **Bug ID**: `BUG-NNN`, three digits, never reused.
> **Severity**: S1 = data loss / security / app unusable · S2 = core flow broken (record → process → results → chat), no workaround · S3 = broken with a workaround, or non-core · S4 = cosmetic.
> **Status**: `open` · `in_progress` · `fixed` · `wontfix` · `duplicate`.
> **Fix type**: `bugfix` (unreleased code, fixed on `dev`) · `hotfix` (affects a released `vX.Y.Z`, fixed on `release/X.Y`).
> **Found in**: version tag (e.g. `v1.0.0`) or `dev`. **Fixed in**: version that ships the fix, or `dev` until released.
> **Feature**: related feature code from `tracking.md`, or `—`. **Link**: branch, then `PR #N` once opened.
> Keep cells free of `|`. Details (repro, root cause) go in the matching `## BUG-NNN` section below the table.

| Bug ID | Title | Severity | Status | Found in | Feature | Fix type | Fixed in | Link |
|---|---|---|---|---|---|---|---|---|
| BUG-001 | docker-compose maps port 3333 but the image listens on 80 | S3 | fixed | v1.0.0 | OPS-04 | bugfix | v1.1.0 | fix/BUG-001-compose-port, PR #3 |
| BUG-002 | avatar_key is unvalidated: any user can read (signed URL) and delete any R2 object | S1 | fixed | v1.0.0 | — | bugfix | v1.1.0 | fix/BUG-002-avatar-key-ownership, PR #7 |
| BUG-003 | meetings.audio_path (and other columns) user-editable under RLS: audio-url + pipeline read another user's audio | S1 | fixed | v1.0.0 | PRV-02 | bugfix | v1.1.0 | fix/BUG-003-meetings-audio-path-trust, PR #8 |
| BUG-004 | Folder delete with deleteMeetings=true removes audio from the Supabase bucket only, ignoring R2 | S3 | fixed | v1.0.0 | — | bugfix | v1.1.1 | fix/BUG-011-folder-delete-own-meetings, PR #19 |
| BUG-005 | SECURITY DEFINER RPCs quota_apply_movement / claim_next_job are callable by anon/authenticated (no REVOKE EXECUTE) | S1 | fixed | v1.0.0 | — | bugfix | v1.1.0 | fix/BUG-005-revoke-definer-rpc-execute, PR #9 |
| BUG-006 | admin_config + storage_config ciphertext readable over REST (column REVOKE under a table-level GRANT is ineffective) | S3 | fixed | v1.0.0 | — | bugfix | v1.1.1 | fix/BUG-006-revoke-ciphertext-tables, PR #17 |
| BUG-007 | transcript_segments / transcript_chunks are client-writable: a shared-folder owner can plant RAG chunks for grantees | S2 | fixed | v1.0.0 | — | bugfix | v1.1.0 | fix/BUG-007-revoke-transcript-client-writes, PR #10 |
| BUG-008 | Direct PostgREST DELETE of an own meeting skips storage cleanup (audio orphaned, outside retention purge) | S3 | fixed | v1.0.0 | PRV-02 | bugfix | v1.1.1 | fix/BUG-008-revoke-meetings-delete, PR #18 |
| BUG-009 | todos / calendar_suggestions are client-writable on every column: owner/editor can spoof action items and .ics events for grantees | S3 | fixed | v1.0.0 | — | bugfix | v1.1.0 | fix/BUG-009-010-revoke-content-client-writes, PR #11 |
| BUG-010 | chat_sessions / chat_messages are client-writable (incl. role=assistant, citations); self-injection into own RAG history only | S4 | fixed | v1.0.0 | — | bugfix | v1.1.0 | fix/BUG-009-010-revoke-content-client-writes, PR #11 |
| BUG-011 | Folder delete with deleteMeetings=true also deletes OTHER users' meetings (shared-folder editors) and their audio | S2 | fixed | v1.0.0 | — | bugfix | v1.1.1 | fix/BUG-011-folder-delete-own-meetings, PR #19 |
| BUG-012 | `meeting_deleted` activity events were never stored (FK to the already-deleted meeting row) | S3 | fixed | v1.0.0 | — | bugfix | v1.1.1 | fix/BUG-011-folder-delete-own-meetings, PR #19 |
| BUG-013 | Deleting a shared folder cascades away grantees' folder-scoped chat sessions | S3 | wontfix | v1.0.0 | — | — | — | by design, see details; UI warning split into BUG-014 |
| BUG-014 | Folder delete dialog does not warn that folder chat history (incl. shared members') is deleted | S4 | fixed | v1.0.0 | RAG-04 | bugfix | v1.1.1 | fix/BUG-014-folder-delete-chat-warning, PR #20 |
| BUG-015 | Folder delete confirm shows the wrong meeting count (skips pinned meetings, counts other users' meetings) | S3 | fixed | v1.0.0 | MMG-04 | bugfix | v1.1.1 | fix/BUG-015-folder-delete-count, PR #21 |
| BUG-016 | After "Delete folder" (keep meetings), shared members' meetings show as ghost rows in the owner's Uncategorized until reload | S4 | fixed | v1.0.0 | MMG-04 | bugfix | v1.1.1 | fix/BUG-016-folder-delete-ghost-rows, PR #23 |
| BUG-017 | Docs drift: CLAUDE.md §11 has no v1.1.0 line; PRV-03 spec says Not started while tracking marks it done (superseded) | S4 | fixed | v1.1.0 | PRV-03 | bugfix | v1.1.1 | fix/BUG-017-docs-drift, PR #24 |
| BUG-018 | Docs drift: default branch is dev (not main), backup environment has no branch policy and no secrets, §11 missing v1.1.1, PRF-08 still open | S4 | fixed | v1.1.1 | OPS-03 | bugfix | dev | fix/BUG-018-docs-drift-backup-branch, PR #30 |
| BUG-019 | migrate_from_supabase crashes printing the report on a Windows console (cp1252) and exits 1 even on PASS | S3 | fixed | dev | ARC-03 | bugfix | dev | fix/BUG-019-migrate-console-encoding, PR #39 |
| BUG-020 | Migration preflight blocks every run: v2-only tables drive_config / storage_objects (migration 0003) not skipped | S2 | fixed | dev | ARC-17 | bugfix | dev | fix/BUG-020-migration-v2-only-tables, PR #42 |

---

## Details

<!-- Template — copy for each bug, newest at the bottom:

## BUG-NNN — <Title>

**Reported:** YYYY-MM-DD · **Severity:** S? · **Found in:** v?.?.? / dev · **Feature:** <CODE or —>

**Steps to reproduce**
1. ...

**Expected**
...

**Actual**
... (exact error / log line)

**Root cause**
...

**Fix**
<what changed, regression test name: tests/<file>.test.ts — "<test name>">

-->

## BUG-001 — docker-compose maps port 3333 but the image listens on 80

**Reported:** 2026-10-21 · **Severity:** S3 · **Found in:** v1.0.0 (also `dev`) · **Feature:** OPS-04

**Steps to reproduce**
1. `docker compose --env-file .env.local up --build -d`
2. Open http://localhost:3333 (as README says), then `docker compose ps`.

**Expected**
App answers on http://localhost:3333 and the container becomes `healthy`.

**Actual**
Connection reset / empty reply on :3333; container stays `unhealthy` (compose healthcheck `wget http://localhost:3333/` fails). Plain `docker run -p 3333:3333` from README fails the same way.

**Root cause**
Commit `e727faf` (2026-07-13) removed nginx from the image (nginx :80 → Next :3000) and made Next.js listen directly on `PORT=80` / `EXPOSE 80`. `docker-compose.yml` (`ports: "3333:3333"`, healthcheck on `localhost:3333`) and README (nginx on 3333, `-p 3333:3333`) were not updated, so the host port forwards to a container port nothing listens on. Production is unaffected (deployment repo maps its own port).

**Fix**
`docker-compose.yml`: `ports` → `"3333:80"`; removed the compose-level healthcheck so the image's `HEALTHCHECK` (`GET /api/health` on :80) applies. README: Docker section no longer mentions nginx; `docker run -p 3333:80`; port table fixed.

**No automated regression test** — the bug is pure container config (compose port mapping vs image `PORT`); there is no logic to extract into a pure function, and project tests must be I/O-free (§10). Manual repro instead (2026-10-21, Docker 29.5.2, image built from this branch):
- Before (`-p 3333:3333`): `curl localhost:3333/api/health` → empty reply (curl exit 52); in-container `:3333` connection refused, `:80` → `{"status":"ok"}`.
- After (fixed compose): container `healthy`, ports `0.0.0.0:3333->80/tcp`, `curl localhost:3333/api/health` → `{"status":"ok"}`, `/` → 200.

Follow-ups (not in this fix): delete dead `start.sh` + `nginx.conf` (pre-`e727faf` nginx setup); optionally pin `PORT: "80"` in compose `environment:` so a `PORT` in `.env.local` can't override it; Dockerfile comments still say secrets come from Kubernetes.

## BUG-002 — avatar_key is unvalidated: any user can read and delete any R2 object

**Reported:** 2026-10-21 · **Severity:** S1 (security) · **Found in:** v1.0.0 · **Feature:** —

Found during the PRV-02 security review.

**Steps to reproduce**
1. As a signed-in user, set `profiles.avatar_key` to another user's audio key (`<victimId>/<meetingId>.webm`), either with `PATCH /api/profile { "avatar_key": … }` or directly via PostgREST (migration 018 grants UPDATE on `avatar_key`).
2. `GET /api/profile` → `avatar_url` is a signed R2 URL for the victim's recording (**read**).
3. `PATCH /api/profile` with any other `avatar_key` → the server deletes the stored key with R2 credentials (**delete**).

**Expected**
Only the caller's own avatar object (`avatars/<user_id>/<uuid>.<ext>`) can be signed or deleted.

**Actual**
Any R2 object could be read or deleted, including other users' meeting audio.

**Root cause**
`avatar_key` was accepted as any string and later trusted by `createSignedDownloadUrl` (GET) and `deleteObject` (PATCH) in `app/api/profile/route.ts`.

**Fix**
New pure `isOwnedAvatarKey(key, userId)` (`lib/profile/avatarKey.ts`): only `^avatars/<userId>/<lowercase uuid>.(jpg|png|webp)$`, the exact format `POST /api/profile/avatar` issues. Checked at use time in all three places: GET signs only an owned key; PATCH returns 422 for a non-owned new key; PATCH deletes the old key only if it is owned (otherwise logs a warning and leaves it). Regression tests: `tests/avatar-key.test.ts`, e.g. "BUG-002: rejects another user's meeting audio key (read via signed URL / delete via R2)". They failed first (module missing), then 8/8.
Follow-ups (not fixed here): PATCH deletes the old avatar before the DB update, so a failed update leaves a broken avatar; `avatar_key` is still in the column grant (a CHECK or dropping it from the grant would add defence in depth); the presigned avatar PUT is not length-bound (the 2 MB limit is advisory); `profile/page.tsx:510` expects `avatar_url` from PATCH, which returns `{ ok: true }`.

## BUG-003 — meetings.audio_path (and other columns) user-editable under RLS

**Reported:** 2026-10-21 · **Severity:** S1 (raised from S2 during the BUG-002 review) · **Found in:** v1.0.0 · **Feature:** PRV-02

**Steps to reproduce**
1. With the anon key and a user JWT: `PATCH /rest/v1/meetings?id=eq.<own meeting>` with `{ "audio_path": "<victimId>/<victimMeetingId>.webm" }`.
2. `GET /api/audio-url/<ownMeetingId>` → a signed URL to the victim's recording (**read**).
3. Or trigger `POST /api/meetings/<ownMeetingId>/process` (failed/pending meeting) → the victim's audio is downloaded, transcribed and summarized into the attacker's meeting.

**Expected**
Users can only change the columns the UI edits (title, pinned_at, folder_id, …). Server code only touches a meeting's own object.

**Actual**
`meetings_update` (migration 025) allows owner and editor UPDATE on every column, with no column-level grant. The service-role **deletes** now check `isOwnedAudioKey` (PRV-02: purge, meeting delete, admin user delete, folder delete, /uploaded), but the **reads** do not: `app/api/audio-url/[id]/route.ts` (~L70) and the pipeline download in `lib/jobs/steps/start.ts` (~L73) / `lib/pipeline/processMeeting.ts` (~L64). Users can also fake the "Audio deleted" notice, force an early purge of a shared meeting (an editor setting `created_at`), or block reprocessing.

**Root cause**
No `REVOKE UPDATE … GRANT UPDATE(<columns>)` on `meetings` (the pattern used for `profiles`, §9b), plus read paths that trust `audio_path`.

**Fix**
(1) New pure `ownedAudioPath(meeting)` (`lib/retention/policy.ts`, on top of `isOwnedAudioKey`; it binds the key to both `user_id` and `id`). `GET /api/audio-url/:id` returns 404 and logs `{ meetingId, userId }` for a non-owned path. The three pipeline download sites (`lib/jobs/steps/start.ts`, `lib/jobs/steps/transcribePoll.ts` lang-retry, `lib/pipeline/processMeeting.ts`) throw. In the job steps it is a terminal `PipelineError`, so there is no retry loop, and `transcribePoll` releases its Speechmatics key slot before the check.
(2) `migrations/033_meetings_revoke_client_writes.sql`: `REVOKE INSERT, UPDATE ON public.meetings FROM anon, authenticated`. Every app write already used the service role (verified in review: no browser or user-scoped writes, no realtime, no SQL function writing as the caller). SELECT and DELETE are unchanged. The file includes a privilege check and a forensics query.
Regression tests in `tests/retention.test.ts`, including "BUG-003: a forged audio_path pointing at another user's recording is not signable or downloadable" and the rewritten-user_id case. They failed first with `(0 , import_policy.ownedAudioPath) is not a function`, then 29/29.

## BUG-004 — Folder delete with deleteMeetings=true ignores R2

**Reported:** 2026-10-21 · **Severity:** S3 · **Found in:** v1.0.0 · **Feature:** —

**Steps to reproduce**
1. Delete a folder with `?deleteMeetings=true` whose meetings have `storage_provider = 'r2'`.

**Expected**
Their audio objects are removed from R2.

**Actual**
`app/api/folders/[id]/route.ts` calls `storage.from('recordings').remove()` (legacy Supabase bucket only), so R2 audio is orphaned. The ownership guard (PRV-02) is applied; the provider handling is not.

**Root cause**
Predates the R2 move; does not use `lib/storage` `deleteObjects`. Also: the route ignores the result of the meetings row delete (`app/api/folders/[id]/route.ts` ~L114), so a failed delete is silent. (Re-confirmed in the BUG-008 review.)

**Fix**
New pure `ownedAudioDeleteItems(rows)` in `lib/retention/policy.ts` returns `{ key, provider }` for each meeting's own audio (via `ownedAudioPath`; forged/foreign keys and meetings without audio are skipped). `DELETE /api/folders/:id?deleteMeetings=true` now selects `storage_provider`, deletes with provider-aware `deleteObjects` (failures logged by count, non-fatal), and returns 500 instead of continuing when the meetings lookup or row delete fails. If the row delete fails after the audio was removed, retrying the folder delete is safe (deleting a missing object succeeds on R2 and Supabase).
Regression tests in `tests/retention.test.ts`, incl. "BUG-004: keeps each object's provider so R2 audio is deleted from R2" — failed first (`ownedAudioDeleteItems is not a function`), then 32/32.

## BUG-005 — SECURITY DEFINER RPCs callable by anon/authenticated

**Reported:** 2026-10-21 · **Severity:** S1 (verify first) · **Found in:** v1.0.0 · **Feature:** —

Found in the BUG-003 security review.

**Steps to reproduce**
1. Check: `select has_function_privilege('authenticated','public.quota_apply_movement(uuid,bigint,int,text,text,boolean,uuid,uuid,jsonb)','execute');`
2. If true: `POST /rest/v1/rpc/quota_apply_movement` with a user JWT, any `p_user_id` and a positive delta.

**Expected**
Only the service role can call `quota_apply_movement` (migration 020) and `claim_next_job` (migration 021).

**Actual**
Neither function revokes EXECUTE. Postgres grants EXECUTE to PUBLIC by default (and Supabase default privileges grant it to anon/authenticated), so the comments "no GRANT = not callable" are wrong. Likely impact: minting quota for any user; grabbing or stalling pipeline jobs and reading job rows. Related: migration 024 revokes `can_access_meeting` from anon only, so PUBLIC still has it (boolean result, low impact).

**Root cause**
SECURITY DEFINER functions created without `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated`.

**Fix**
**Pending DB apply:** the hole stays open on the live DB until migration 034 is applied and verified. It is independent of app code, so apply it now.
`migrations/034_revoke_definer_rpc_execute.sql`: `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated` plus `GRANT EXECUTE … TO service_role` for `quota_apply_movement(uuid,bigint,int,text,text,boolean,uuid,uuid,jsonb)` and `claim_next_job(text)`. Both are only called server-side with the service-role client (`lib/quota/applyQuotaMovement.ts`, `lib/jobs/worker.ts`), so app behaviour is unchanged. New CLAUDE.md §6 rule: every SECURITY DEFINER function must revoke EXECUTE from PUBLIC.
**No automated test:** this is a database privilege, and project tests must be pure with no I/O (§10). Repro/verify = the `has_function_privilege` query in the migration (before: true for anon/authenticated; after: false for anon/authenticated, true for service_role).
Not changed: `can_access_meeting` still has PUBLIC EXECUTE (it returns a boolean for the caller, low impact). Revoking PUBLIC would also make anon RLS evaluation raise errors instead of returning empty, so it needs its own check. `prevent_role_escalation` is SECURITY DEFINER but returns `trigger`, which PostgREST cannot call; `custom_access_token_hook` was already revoked in migration 002.

## BUG-006 — admin_config + storage_config ciphertext readable over REST

**Reported:** 2026-10-21 · **Severity:** S3 · **Found in:** v1.0.0 · **Feature:** —

**Actual**
`migrations/023_rls_admin_config_column_privilege.sql` revokes SELECT on `value_ciphertext, value_iv, value_auth_tag` at column level, which does not override the table-level SELECT grant. Admins can read the ciphertext via REST. This is useless without `KEY_ENCRYPTION_SECRET`, but it breaks the §9f "ciphertext never returned" invariant.

**Fix**
**Pending DB apply** (independent of app code; apply now).
`migrations/037_revoke_ciphertext_tables.sql`: `REVOKE ALL ON admin_config, storage_config FROM anon, authenticated`. The scope was widened with the owner's OK to `storage_config` (R2 secret), which had the same admin-SELECT-without-column-restriction hole. (`provider_keys` is not included: it was dropped in migration 015.) Reproduced on a throwaway Postgres 16: with 023's column revoke in place, `authenticated` could still SELECT `value_ciphertext` (true); after 037, every anon/authenticated privilege on both tables is false and service_role still reads. No browser or user-scoped client touches these tables. Every reader and writer is a service-role API route or `lib` module (keys, storage, ai-usage, healthcheck, provider), so the admin UI is unchanged and the admin SELECT policies become inert. New rule in CLAUDE.md §9f.
**No automated test:** this is a DB privilege, and tests must be pure (§10). Repro/verify = the query in the migration (before: `SELECT` true for authenticated; after: all false).

## BUG-007 — transcript_segments / transcript_chunks are client-writable

**Reported:** 2026-10-21 · **Severity:** S2 · **Found in:** v1.0.0 · **Feature:** —

**Actual**
The RLS in migration 025 lets the meeting owner INSERT/UPDATE `transcript_segments` and `transcript_chunks` (including `content` and `embedding`) directly. The owner of a shared folder can plant chunks crafted for retrieval that then appear in grantees' RAG prompts (prompt injection, CWE-1426), bypassing the pipeline.

**Fix**
**Pending DB apply:** the migration is independent of app code, so apply it now.
`migrations/035_transcript_revoke_client_writes.sql`: `REVOKE INSERT, UPDATE, DELETE, TRUNCATE` on both tables `FROM anon, authenticated`. Every write was already service-role (pipeline `transcribePoll`/`embed`/`processMeeting`, the admin requeue route; regenerate only reads). The browser only SELECTs segments, and chunks are read via the SECURITY INVOKER `match_transcript_chunks`. SELECT is unchanged. New CLAUDE.md §6 rule.
**No automated test:** this is a DB privilege, and project tests must be pure with no I/O (§10). Repro/verify = the query in the migration (before: true for anon/authenticated; after: all false).
Not covered: rows planted before the migration are not detected. Admin requeue rebuilds a meeting's segments and chunks from its audio. `meetings` (migration 033) has the same TRUNCATE gap, which is not reachable via PostgREST.

## BUG-008 — Direct DELETE of an own meeting skips storage cleanup

**Reported:** 2026-10-21 · **Severity:** S3 · **Found in:** v1.0.0 · **Feature:** PRV-02

**Actual**
Owner-only RLS DELETE on `meetings` lets a user delete the row via PostgREST, skipping `DELETE /api/meetings/:id`, which removes the audio first (§6). The object is orphaned, and the retention purge never sees it because there is no row.

**Fix**
**Pending DB apply** (independent of app code; apply now).
`migrations/038_meetings_revoke_client_delete.sql`: `REVOKE DELETE, TRUNCATE ON public.meetings FROM anon, authenticated`. The UI only deletes through service-role routes (`DELETE /api/meetings/:id`, folder delete with meetings, `/uploaded` reject, `POST /api/meetings` cleanup); no browser or user-scoped client deletes meetings. With 033 the browser is now SELECT-only on `meetings`.
**No automated test:** this is a DB privilege, and tests must be pure (§10). Verified on a throwaway Postgres 16 with the real FK shapes: after 038, `authenticated` direct `DELETE FROM meetings` → `permission denied`; deleting a folder as `authenticated` still sets `meetings.folder_id` to NULL, and deleting a user still cascades to meetings + todos (referential actions don't need the caller's grant).

## BUG-009 — todos / calendar_suggestions are client-writable on every column

**Reported:** 2026-10-21 · **Severity:** S3 · **Found in:** v1.0.0 · **Feature:** —

Found in the BUG-007 security review.

**Actual**
Migration 025 lets the owner INSERT and the owner or a shared-folder editor UPDATE/DELETE any column of `todos` and `calendar_suggestions` via PostgREST. The intended path, the PATCH routes, only sets `status` / `dismissed`. Users can spoof `content`, `assignee`, `due_date`, `title`, `raw_mention` and `proposed_at`, and the `.ics` export uses those values. These tables are not fed to the RAG prompt, so the risk is content spoofing in the UI and `.ics`, not prompt injection.

**Fix**
**Pending DB apply:** the migration is independent of app code, so apply it now.
`migrations/036_content_revoke_client_writes.sql` (shared with BUG-010): `REVOKE INSERT, UPDATE, DELETE, TRUNCATE` on `todos` and `calendar_suggestions` (plus the chat tables) `FROM anon, authenticated`. All writes were already service-role (`lib/jobs/steps/analyse.ts`, `processMeeting.ts`, the PATCH routes, admin requeue). The browser only SELECTs. Status/dismiss changes still work through the PATCH routes.
**No automated test:** this is a DB privilege, and tests must be pure (§10). Verify = the query in the migration (all false).

## BUG-010 — chat_sessions / chat_messages are client-writable

**Reported:** 2026-10-21 · **Severity:** S4 · **Found in:** v1.0.0 · **Feature:** —

**Actual**
The session owner can INSERT/UPDATE/DELETE their own chat messages, including `role='assistant'` and `citations` (migrations 012, 025). The last 4 history messages go into their own RAG prompt (`app/api/chat/route.ts`). This is self-injection only, because sessions are scoped to `auth.uid()`. All app writes already use the service role.

**Fix**
Fixed by `migrations/036_content_revoke_client_writes.sql` together with BUG-009. All chat writes were already service-role (`app/api/chat/route.ts`, `createServerClient`). **Pending DB apply.** No automated test (DB privilege).

## BUG-011 — Folder delete with deleteMeetings=true deletes other users' meetings

**Reported:** 2026-10-22 · **Severity:** S2 (data loss across users) · **Found in:** v1.0.0 · **Feature:** —

Found in the BUG-004 review.

**Steps to reproduce**
1. User A shares folder F with user B as **editor**.
2. B creates a meeting in F (`POST /api/meetings` with `folder_id`) or moves their own meeting into F (`PATCH /api/meetings/:id`) — allowed by `canAssignToFolder` (`lib/access/index.ts`, editor+).
3. A calls `DELETE /api/folders/F?deleteMeetings=true`.

**Expected**
Only A's own meetings are deleted; B's meetings are not destroyed by another user.

**Actual**
The route selects every meeting with `folder_id = F` (service role, no `user_id` filter) and deletes them all, including B's meeting, transcript, chat and audio, with no `meeting_deleted` activity or audit entry.

**Root cause**
Folder delete treats "meetings in my folder" as "my meetings".

**Fix**
Owner chose (a). `DELETE /api/folders/:id?deleteMeetings=true` now selects only `user_id = caller` meetings in the folder and re-filters them with the new pure `ownMeetingsOnly(rows, callerId)` (`lib/retention/policy.ts`). Other users' meetings are untouched and fall back to Uncategorized via `ON DELETE SET NULL` when the folder is deleted. Each deleted meeting now writes a `meeting_deleted` activity event (via the BUG-012 fix — before it, no `meeting_deleted` event was ever stored).
Regression tests in `tests/retention.test.ts`, incl. "BUG-011: folder delete never selects another user's meeting". They failed first (`ownMeetingsOnly is not a function`), then 35/35.

## BUG-012 — `meeting_deleted` activity events were never stored

**Reported:** 2026-10-22 · **Severity:** S3 · **Found in:** v1.0.0 · **Feature:** —

Found in the BUG-011 review.

**Actual**
`activity_log.meeting_id` is `REFERENCES meetings(id) ON DELETE SET NULL` (migration 016, not deferrable). `DELETE /api/meetings/:id` (and the new folder bulk delete) logged `meeting_deleted` with `meetingId` AFTER deleting the row, so every insert failed with an FK violation (23503), swallowed by fire-and-forget `logActivity`. The admin activity feed never showed a deletion.

**Fix**
New pure `meetingDeletedActivity(meetingId)` (`lib/activity/entries.ts`) → `{ eventType: 'meeting_deleted', meetingId: null, metadata: { meeting_id } }` (id is an identifier, not content — §9g). Used by both delete routes. Regression test "BUG-012: meeting_deleted never references the deleted row via the meeting_id FK" (`tests/activity-log.test.ts`) — failed first (module missing), then passed. Fixed in the same branch as BUG-011.

## BUG-013 — Deleting a shared folder cascades away grantees' folder-scoped chat sessions

**Reported:** 2026-10-22 · **Severity:** S3 · **Found in:** v1.0.0 · **Feature:** —

Found in the BUG-011 review.

**Actual**
`chat_sessions.folder_id` is `REFERENCES folders(id) ON DELETE CASCADE` (migration 018). Any folder delete (with or without `deleteMeetings`) deletes every user's folder-scoped chat sessions and messages, including grantees', with no log.

**Resolution: wontfix (by design), 2026-10-23**
Folder chat history is gated by folder access: `GET`/`POST /api/chat` with `folderId` require viewer+ on the folder (`checkFolderAccess`), and no other UI lists `chat_sessions`. A grantee's access to the owner's meetings in the folder comes only from the share, so once the folder is deleted they cannot read those meetings any more (deleted, or moved to the owner's Uncategorized; an editor-grantee's own meetings stay theirs, BUG-011). Keeping their sessions (`ON DELETE SET NULL`) would leave rows nobody can open (global scope has no history view) that still quote content the grantee is no longer allowed to see — against the access model and the privacy-first goal. `CASCADE` is therefore correct.
Remaining gap — the delete dialog doesn't say chat history goes too — is tracked as BUG-014.

## BUG-014 — Folder delete dialog does not warn that folder chat history (incl. shared members') is deleted

**Reported:** 2026-10-23 · **Severity:** S4 · **Found in:** v1.0.0 · **Feature:** RAG-04

Split from BUG-013.

**Steps to reproduce**
1. As a folder owner, share a folder and use its folder chat (yours and a member's).
2. `/meetings` → folder menu → Delete.

**Expected**
The confirm panel says the folder's chat history — including shared members' chats — is deleted too.

**Actual**
Neither delete confirmation mentions chat history — the folder-card menu panel ("Delete “<name>”?" + what to do with the meetings) nor the Manage Folders modal panel ("…will move to Uncategorized"); chat history disappears for everyone without warning.

**Root cause**
`chat_sessions.folder_id` is `ON DELETE CASCADE` by design (BUG-013), but neither confirm panel in `app/(routes)/meetings/page.tsx` mentions it.

**Fix**
New pure `folderDeleteChatNotice(memberCount)` (`lib/folders/deleteNotice.ts`) — "Folder chat history will be deleted." plus "for everyone, including any chats by its N shared member(s)" when the folder is shared; guards negative / fractional / non-finite counts. Rendered in both confirm panels in `app/(routes)/meetings/page.tsx` (folder-card menu and Manage Folders modal); both are owner-only, matching `memberCount` (owned folders only). Regression tests: `tests/folder-delete-notice.test.ts`, e.g. "BUG-014: says it is deleted for everyone, including shared members" — failed first (module missing), then 3/3.
Not verified: manual click-through in a browser (layout/wrapping of the new line).
Follow-ups (not fixed here): "Delete folder + all N meetings" doesn't mention that those meetings' chats go too (meeting-scoped cascade); wrong N logged as BUG-015.

## BUG-015 — Folder delete confirm shows the wrong meeting count

**Reported:** 2026-10-23 · **Severity:** S3 · **Found in:** v1.0.0 · **Feature:** MMG-04

Found in the BUG-014 review.

**Actual**
In `app/(routes)/meetings/page.tsx` the folder-card delete panel uses `folderItems = nonPinnedMeetings.filter(m => m.folder_id === f.id)` for "This folder has N meetings" / "Delete folder + all N meetings". Pinned meetings in the folder are left out, and other users' meetings (editors' own meetings in a shared folder) are counted although `DELETE /api/folders/:id?deleteMeetings=true` only deletes the owner's meetings since BUG-011. The owner can be told the wrong number of meetings will be deleted.

**Fix**
New pure `folderDeleteCounts(meetings, folderId, callerId)` → `{ total, deletable, othersMoved }` (`lib/folders/deleteNotice.ts`): `total` = every meeting in the folder incl. pinned; `deletable` = the caller's own (exactly what the route deletes); unknown caller (user not loaded yet) → no ownership claim (`deletable` and `othersMoved` 0). The folder-card panel in `app/(routes)/meetings/page.tsx` now offers "Delete folder + all|my N meetings" only when `deletable > 0` and says how many belong to shared members and move to their Uncategorized; when nothing is deletable it shows a sentence plus "Delete folder" / "Cancel". The card's meeting count also uses `total` (pinned included), matching the Manage Folders modal. Regression tests: `tests/folder-delete-notice.test.ts`, e.g. "BUG-015: counts pinned meetings in the folder", "BUG-015: only the caller's meetings are deletable (others move to their Uncategorized)" — failed first (`folderDeleteCounts is not a function`), then pass; review round 2 updated the unknown-caller test first (1 fail), then 8/8.
Not verified: browser click-through of the panel states; a real shared folder with an editor's meetings.
Follow-up: BUG-016 (ghost rows after a keep-delete).

## BUG-016 — After "Delete folder" (keep meetings), shared members' meetings show as ghost rows

**Reported:** 2026-10-23 · **Severity:** S4 · **Found in:** v1.0.0 · **Feature:** MMG-04

Found in the BUG-015 review.

**Actual**
`deleteFolder(id, false)` in `app/(routes)/meetings/page.tsx` maps every meeting of the folder to `folder_id: null` in local state, including other users' meetings. Once the folder is gone the owner loses RLS access to those, so they appear in the owner's Uncategorized until the next reload.

**Root cause**
The keep path updated local state as if every meeting in the folder stayed visible to the owner, but `can_access_meeting` only grants a non-owner access through a non-null `folder_id`; after `ON DELETE SET NULL` the owner can no longer read other users' meetings (admins neither, since migration 025).

**Fix**
New pure `meetingsAfterFolderDelete(meetings, folderId, callerId, deleteMeetings)` (`lib/folders/deleteNotice.ts`), used by `deleteFolder` in `app/(routes)/meetings/page.tsx`: delete path removes every folder meeting (unchanged); keep path moves the caller's meetings to Uncategorized and drops other users'; unknown caller (`''`) falls back to the old behaviour (unreachable in practice: the delete action is owner-gated on `currentUserId`). Regression test: `tests/folder-delete-notice.test.ts` — "BUG-016: keep path drops shared members' meetings instead of showing them as ghost rows" — failed first (`meetingsAfterFolderDelete is not a function`), then 12/12.
Not verified: browser click-through with a real shared folder (owner + editor).

## BUG-017 — Docs drift: §11 missing v1.1.0, PRV-03 spec status

**Reported:** 2026-10-23 · **Severity:** S4 · **Found in:** v1.1.0 · **Feature:** PRV-03

From the 2026-10-23 `/copilot plan` snapshot (roadmap Now 6).

**Actual**
- `CLAUDE.md` §11 ends with "v1.0.0 released"; v1.1.0 (2026-10-22) is not mentioned.
- `ai-instruction/features/feature-PrivacyData-PRV.md` PRV-03 says `❌ Not started`, while `tracking.md` marks it `[x]` with "Superseded … purge delivered by PRV-02" (roadmap decision 2026-10-22).

Two other reported items were checked and are **not** drift: CHANGELOG [1.1.0] Known issues listing BUG-004/006/008 as open is correct history (they were open at release; the fixes are under `[Unreleased]`), and `CLAUDE.md` §9a on `dev` already lists migrations 032–038 (items 10–16).

**Root cause**
Close-out steps for the v1.1.0 release and the PRV-03 supersede decision updated only one of the two documents.

**Fix**
§11: added a "v1.1.0 released (2026-10-22)" line. PRV-03 spec status → `✅ Done — superseded by PRV-02`. **No automated regression test** — documentation only, no logic; verified that the seeder parser still reads PRV-03 as `done` (`parseModuleFile` + `mergeWithTracking`).

## BUG-018 — Docs drift: default branch, backup environment, §11 v1.1.1, PRF-08

**Reported:** 2026-10-25 · **Severity:** S4 · **Found in:** v1.1.1 · **Feature:** OPS-03 (also PRF-08)

From the 2026-10-25 `/copilot plan` snapshot (roadmap Now 4) and the first manual `db-backup` run on `dev` (run 40164320128).

**Actual**
- `CLAUDE.md` §9k says the GitHub default branch is `main`; it is `dev` (`gh repo view --json defaultBranchRef`). The `/fix-bug` skill repeats it.
- `CLAUDE.md` §9o, `docs/ops/backup-restore.md` and comments in `.github/workflows/backup.yml` say the `backup` environment releases secrets to `main` only and that `schedule` runs from `main`. In fact `schedule` runs from the default branch `dev`; the environment has no branch policy and **no secrets** (`gh secret list --env backup` is empty). Every scheduled and manual run failed at "Check secrets are set" (`missing secret SUPABASE_DB_URL` …).
- `CLAUDE.md` §11 has no line for v1.1.1 (released 2026-10-25).
- `tracking.md` PRF-08 is `[ ]` and its spec says `❌ Not started`, although AIP-06 delivered it (migration 027 `profiles.default_provider/default_model`, `/api/profile/preferences` rejects models outside the allow-list).

**Root cause**
The docs assumed the default branch was `main` (true at some point or never set); nobody re-checked after OPS-03 shipped. The backup secrets were never created, which the docs hid by blaming the branch. AIP-06 close-out did not tick PRF-08.

**Fix**
Docs and comments now state the real setup: default branch `dev`; `backup` environment must release secrets to `dev` (recommended branches `main` + `dev`) and needs the six environment secrets; manual run `gh workflow run backup.yml --ref dev`. §11 gained the v1.1.1 line. PRF-08 `[x]` + spec `✅ Done — delivered by AIP-06`. Workflow behaviour unchanged (comments only). **No automated regression test** — documentation only, no logic; verified the seeder still parses PRF-08 as `done`. Owner action still open: create the six `backup` environment secrets and restrict its branches to `main` + `dev`.

## BUG-019 — migrate_from_supabase crashes printing the report on a Windows console (cp1252)

**Reported:** 2026-10-29 · **Severity:** S3 · **Found in:** dev (ARC-03 rehearsal 1) · **Feature:** ARC-03

**Steps to reproduce**
1. Windows, PowerShell or Git Bash, no `PYTHONIOENCODING`.
2. `uv run --env-file .env.migrate python -m scripts.migrate_from_supabase --confirm-target <host> --skip-storage --dry-run`

**Expected**
The report is printed and the exit code is 0 (PASS or dry run), 1 (FAIL) or 2 (blocked).

**Actual**
`UnicodeEncodeError: 'charmap' codec can't encode character '→' in position 134: character maps to <undefined>`
from `print(text)` in `main()`. The report file is complete, but the exit code is always 1.

**Root cause**
`main()` prints the Markdown report (it contains `→`, `✅`, `❌`) with `print()`. On Windows stdout uses the console
code page (cp1252) with the `strict` error handler, so the first non-cp1252 character raises before `main()` returns
its exit code. stderr uses `backslashreplace`, which is why the `source → target` line did not crash.

**Fix**
`emit_report(text, stream)` in `scripts/migrate_from_supabase.py` writes the report re-encoded with the stream's own
encoding and `errors="replace"` (characters the console lacks become `?`; a missing stdout is a no-op); `main()` uses it
instead of `print()`. The report file is unchanged (UTF-8, full text). Regression tests:
`app/api/tests/test_migration_transform.py` — `test_bug019_report_prints_on_a_cp1252_console` (strict cp1252 stream; asserts
the `→` became `?`) and `test_bug019_report_keeps_unicode_on_a_utf8_console`. Verified: the original dry run on Windows
without `PYTHONIOENCODING`, stdout piped, now prints and exits 0.

## BUG-020 — Migration preflight blocks every run: v2-only tables from migration 0003 not skipped

**Reported:** 2026-11-02 · **Severity:** S2 · **Found in:** dev (after PR #41) · **Feature:** ARC-17, ARC-03

**Steps to reproduce**
1. `dev` after PR #41 (ARC-17, Alembic revision `0003_drive_storage`).
2. Target migrated to head; run `python -m scripts.migrate_from_supabase --confirm-target <host> --skip-storage --dry-run`
   (or `pytest tests/test_migration_integration.py` against Postgres 18).

**Expected**
Preflight passes; tables are copied in FK order.

**Actual**
Report blocked: `source has no table public.drive_config`, `source has no table public.storage_objects`.
8 tests in `test_migration_integration.py` fail, so `ci-api` on `dev` is red. Not caught in PR #41 because the
sandbox could not run the DB integration tests (no Postgres 18 at the time).

**Root cause**
`scripts/migrate_from_supabase.py` lists tables with no v1 counterpart by hand: `V2_ONLY_TABLES` (preflight) and a
second hard-coded `{"refresh_tokens", "email_tokens"}` in `migrate_tables`. Migration 0003 added `drive_config` and
`storage_objects` without updating either list.

**Fix**
Both tables added to `V2_ONLY_TABLES`; `migrate_tables` now skips `NOT_COPIED_TABLES = V2_ONLY_TABLES - {"users"}`
(one source of truth). Regression test `app/api/tests/test_migration_transform.py` —
`test_bug020_every_table_created_after_the_baseline_is_v2_only`: every table created by a v2-only migration
(`migrations/sql/0002+`, not `_down`) must be in both sets, so a future migration that forgets this fails in the pure
suite. Verified against `pgvector/pgvector:pg18`: full `pytest -q` 819 passed (8 failures before).
