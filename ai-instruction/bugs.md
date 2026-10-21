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
| BUG-002 | PATCH /api/profile deletes any R2 object named by a user-supplied avatar_key | S1 | open | v1.0.0 | — | — | — | — |
| BUG-003 | meetings columns (audio_path, status, created_at, audio_purged_at) are user-editable under RLS | S2 | open | v1.0.0 | PRV-02 | — | — | — |
| BUG-004 | Folder delete with deleteMeetings=true removes audio from the Supabase bucket only, ignoring R2 | S3 | open | v1.0.0 | — | — | — | — |

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

## BUG-002 — PATCH /api/profile deletes any R2 object named by a user-supplied avatar_key

**Reported:** 2026-10-21 · **Severity:** S1 (security) · **Found in:** v1.0.0 · **Feature:** —

Found during the PRV-02 security review (not fixed there; different key class).

**Steps to reproduce**
1. As a signed-in user, `PATCH /api/profile` with `{ "avatar_key": "<another user's audio key, e.g. <victimId>/<meetingId>.webm>" }`.
2. `PATCH /api/profile` again with any other `avatar_key`.

**Expected**
Only the caller's own avatar object can ever be deleted.

**Actual**
Step 2 calls `deleteObject({ key: oldKey, provider: 'r2' })` (app/api/profile/route.ts ~L181) with R2 credentials on the key stored in step 1, which is never validated, so any R2 object can be deleted, including other users' meeting audio.

**Root cause**
`avatar_key` is accepted as any string and later trusted for a service-credential delete.

**Fix**
<pending: validate avatar_key against the avatar key format/prefix for the caller on write, and check it again before deleting>

## BUG-003 — meetings columns are user-editable under RLS

**Reported:** 2026-10-21 · **Severity:** S2 (security hardening) · **Found in:** v1.0.0 · **Feature:** PRV-02

**Steps to reproduce**
1. With the anon key and a user JWT, `PATCH /rest/v1/meetings?id=eq.<own or editor-shared meeting>` with `{ "audio_path": "...", "status": "done", "created_at": "2000-01-01", "audio_purged_at": "..." }`.

**Expected**
Users can only change the columns the UI edits (title, pinned_at, folder_id, …).

**Actual**
`meetings_update` (migration 025) allows owner + editor UPDATE on every column, with no column-level grant. Service-role deletes now go through `isOwnedAudioKey` (PRV-02), but users can still fake the "Audio deleted" notice, force an early purge of a shared meeting (an editor setting `created_at`), or block reprocessing on meetings they can edit.

**Root cause**
No `REVOKE UPDATE … GRANT UPDATE(<columns>)` on `meetings` (the pattern already used for `profiles`, §9b).

**Fix**
<pending: migration with column-level UPDATE grant; confirm the real column list the app writes from the browser first>

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
