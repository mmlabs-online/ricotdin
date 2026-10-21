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
| BUG-001 | docker-compose maps port 3333 but the image listens on 80 | S3 | fixed | v1.0.0 | OPS-04 | bugfix | dev | fix/BUG-001-compose-port, PR #3 |
| BUG-002 | avatar_key is unvalidated: any user can read (signed URL) and delete any R2 object | S1 | fixed | v1.0.0 | — | bugfix | dev | fix/BUG-002-avatar-key-ownership, PR #7 |
| BUG-003 | meetings.audio_path (and other columns) user-editable under RLS: audio-url + pipeline read another user's audio | S1 | fixed | v1.0.0 | PRV-02 | bugfix | dev | fix/BUG-003-meetings-audio-path-trust |
| BUG-004 | Folder delete with deleteMeetings=true removes audio from the Supabase bucket only, ignoring R2 | S3 | open | v1.0.0 | — | — | — | — |
| BUG-005 | SECURITY DEFINER RPCs quota_apply_movement / claim_next_job are callable by anon/authenticated (no REVOKE EXECUTE) | S1 | open | v1.0.0 | — | — | — | — |
| BUG-006 | admin_config ciphertext columns still readable over REST (column REVOKE under a table-level GRANT is ineffective) | S3 | open | v1.0.0 | — | — | — | — |
| BUG-007 | transcript_segments / transcript_chunks are client-writable: a shared-folder owner can plant RAG chunks for grantees | S2 | open | v1.0.0 | — | — | — | — |
| BUG-008 | Direct PostgREST DELETE of an own meeting skips storage cleanup (audio orphaned, outside retention purge) | S3 | open | v1.0.0 | PRV-02 | — | — | — |

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
Predates the R2 move; does not use `lib/storage` `deleteObjects`.

**Fix**
<pending: use deleteObjects({ key, provider }) like DELETE /api/admin/users/:id>

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
<pending: migration revoking EXECUTE on both functions from PUBLIC, anon, authenticated (keep service_role); also PUBLIC on can_access_meeting>

## BUG-006 — admin_config ciphertext readable over REST

**Reported:** 2026-10-21 · **Severity:** S3 · **Found in:** v1.0.0 · **Feature:** —

**Actual**
`migrations/023_rls_admin_config_column_privilege.sql` revokes SELECT on `value_ciphertext, value_iv, value_auth_tag` at column level, which does not override the table-level SELECT grant. Admins can read the ciphertext via REST. This is useless without `KEY_ENCRYPTION_SECRET`, but it breaks the §9f "ciphertext never returned" invariant.

**Fix**
<pending: REVOKE SELECT ON admin_config FROM authenticated; GRANT SELECT (<safe columns>) ON admin_config TO authenticated>

## BUG-007 — transcript_segments / transcript_chunks are client-writable

**Reported:** 2026-10-21 · **Severity:** S2 · **Found in:** v1.0.0 · **Feature:** —

**Actual**
The RLS in migration 025 lets the meeting owner INSERT/UPDATE `transcript_segments` and `transcript_chunks` (including `content` and `embedding`) directly. The owner of a shared folder can plant chunks crafted for retrieval that then appear in grantees' RAG prompts (prompt injection, CWE-1426), bypassing the pipeline.

**Fix**
<pending: revoke client INSERT/UPDATE on both tables (all writes are service-role), like migration 033>

## BUG-008 — Direct DELETE of an own meeting skips storage cleanup

**Reported:** 2026-10-21 · **Severity:** S3 · **Found in:** v1.0.0 · **Feature:** PRV-02

**Actual**
Owner-only RLS DELETE on `meetings` lets a user delete the row via PostgREST, skipping `DELETE /api/meetings/:id`, which removes the audio first (§6). The object is orphaned, and the retention purge never sees it because there is no row.

**Fix**
<pending: revoke client DELETE on meetings (the UI uses the route), or add an orphan sweep to the purge job>
