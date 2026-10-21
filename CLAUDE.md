# CLAUDE.md

Project memory for Claude Code. Read this fully at the start of every session.
Keep it updated as the project evolves — this file is the source of truth.

## 1. What we are building

A **meeting assistant** web app (MVP). The user records a meeting in the
browser, the app produces a transcript + summary + meeting note, extracts
to-do items and calendar mentions, and offers a RAG chatbot to ask questions
about past meetings (NotebookLM-style).

**MVP scope (build this):**
1. In-browser recording (screen/tab + system audio + mic).
2. Upload audio → process → transcript with timestamps.
3. Meeting note + summary.
4. To-do extraction.
5. RAG chatbot over transcripts (with timestamp citations).
6. Surface calendar suggestions + to-dos in the UI (display only).

**Explicitly OUT of MVP scope (do NOT build yet):**
- Google Calendar OAuth / auto-creating events (MVP only offers `.ics` download).
- Proactive reminders / push notifications.
- Auto-detecting which meeting app is running / auto-starting recording.
- Multi-user collaboration features.
Do not add these without being asked, even if they seem natural.

## 2. Tech stack

- **Next.js (App Router) + TypeScript** — single codebase, frontend + API in one.
  Runs as a long-lived `next start` server on the user's own host (NOT serverless),
  so route handlers may run long tasks directly; no external queue needed for MVP.
- **Supabase** — Postgres (with pgvector), Storage (audio), Auth.
- **Google Gemini** via Google AI Studio API — Flash / Flash-Lite, free tier for MVP.
- Package manager: npm. Node 20+.

## 3. Architecture & data flow

```
Browser (recorder + UI)
  → upload audio to Supabase Storage via presigned URL (direct, not through server)
  → notify server route; create `meetings` row (status=pending)
  → server pipeline: download audio → Gemini Files API → Gemini Flash
      → returns JSON: transcript segments + summary + notes + todos + calendar mentions
  → write rows to Postgres; chunk transcript; embed chunks → transcript_chunks
  → status=done
UI reads results. Chat: embed question → match_transcript_chunks RPC → Gemini answer + citations.
```

## 4. Directory structure (target)

```
/app                      Next.js App Router (pages + route handlers)
  /api                    route handlers (server-only)
  /(routes)               UI pages (meeting list, meeting detail, chat)
/lib
  /gemini                 Gemini service layer (the ONLY place that calls Gemini)
  /supabase               typed Supabase client helpers (browser + server/service)
  /audio                  client-side recording + chunking helpers
/components               React components
/types                    shared TypeScript types (incl. DB row types)
schema.sql                database schema (apply as a migration)
CLAUDE.md                 this file
```

## 5. Conventions

- TypeScript strict mode. No `any` unless justified with a comment.
- Server-only code (anything touching the Gemini key or Supabase service role key)
  lives in `/app/api` route handlers or `/lib` modules imported only by the server.
  **The Gemini API key and the Supabase service role key must NEVER reach the browser.**
- Use the typed Supabase client; mirror DB types in `/types`.
- Errors: throw typed errors in `/lib`, catch + map to HTTP responses in routes.
  User-facing errors are friendly; full detail goes to logs and `meetings.error_message`.
- Naming: `camelCase` in TS, `snake_case` in SQL (matches the schema).
- Keep functions small and single-purpose. Prefer pure functions in `/lib`.

## 6. Database

Schema is in `schema.sql` (Postgres + pgvector). Key tables:
`meetings` (root), `transcript_segments` (canonical transcript), `transcript_chunks`
(embeddings for RAG), `todos`, `calendar_suggestions`, `chat_sessions`,
`chat_messages`. RAG retrieval is the `match_transcript_chunks` RPC.

**`meetings` additional columns (via migrations):**
- `pinned_at timestamptz NULL` (migration 004) — null = not pinned. Set to `now()` to pin.
  List sort: `pinned_at DESC NULLS LAST, created_at DESC` (pinned first, most-recently-pinned on top).
  Index: `meetings_user_pin_sort ON meetings (user_id, pinned_at DESC NULLS LAST, created_at DESC)`.

**Delete rule:** when deleting a meeting, the server route (`DELETE /api/meetings/:id`)
MUST attempt to remove `meetings.audio_path` from Supabase Storage (bucket `recordings`)
using the service-role client BEFORE deleting the row. Storage delete failure is logged
and surfaced as a `warning` field in the response, but the row delete always proceeds
(no half-state). All child rows are removed by `ON DELETE CASCADE` on the DB side
(transcript_segments, transcript_chunks, todos, calendar_suggestions, chat_sessions,
chat_messages).

Rules:
- RLS is ON. The browser uses the anon key (RLS-scoped to the logged-in user).
- The **server pipeline uses the service role key** (bypasses RLS) for background writes.
- Embedding dimension is **768** and must match the `output_dimensionality` we
  request from Gemini's embedding model. Do not change one without the other.

## 7. Gemini integration rules

- All Gemini calls go through `/lib/gemini` — a single service layer. Nothing else
  imports the Gemini SDK directly. This lets us switch free↔paid with zero changes
  elsewhere.
- Use **JSON mode** with a fixed response schema for the pipeline output, and parse
  defensively (strip code fences, validate before using).
- **Retry with exponential backoff on HTTP 429** (free tier hits rate limits often).
- **Chunk long audio** into ~20–30 minute segments before sending, to stay under
  the per-minute token limit; stitch transcripts back together by time offset.
- Default model: `gemini-2.5-flash` for the pipeline (quality), `gemini-2.5-flash-lite`
  is acceptable for cheap/iterative dev runs. Make the model name a config constant.
- Upload audio via the Gemini **Files API** (temporary staging, ~48h retention) and
  reference it in the prompt; do not inline large audio as base64.
- **Free-tier privacy note:** on the free tier, inputs may be used by Google for
  training. For dev/testing use synthetic or non-sensitive recordings only.

## 8. Environment variables

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=        # server only, NEVER exposed to client
GEMINI_API_KEY=                   # server only, NEVER exposed to client (env fallback)
KEY_ENCRYPTION_SECRET=            # 64 hex chars (32 bytes). Generate:
                                  # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
                                  # NEVER log. Losing it makes all stored DB keys unrecoverable.
```
Anything not prefixed `NEXT_PUBLIC_` is server-only. Never log secret values.

## 9. Commands

```
npm run dev        # local development
npm run build      # production build
npm run start      # run the production server (deployment target)
npm run lint       # ESLint
npm run check      # connectivity check: Gemini + Supabase (reads .env.local)
npm run test       # run tests (not yet configured)
```

## 9k. Release process

**Branches:**
- `dev` — day-to-day work; every push → Docker image `ricotdin:dev` (`release-dev.yml`).
- `main` — stable integration branch; only receives PRs from `dev` (and hotfix merge-backs).
- `release/X.Y` — one branch per minor version line, cut from `main`. Receives **bugfixes
  only**, never new features. All `vX.Y.Z` tags live here (`v1.0.0`, `v1.0.1`… on `release/1.0`).
- `ci.yml` runs on push/PR to `main` and `release/**`.

**Versioning:** SemVer. `package.json` `version` MUST equal the tag without the `v`.
`release.yml` rejects a tag that does not match `package.json` or whose commit is not on
`release/X.Y` (the branch matching the tag's major.minor).

**New minor/major release `X.Y.0`:**
1. On `dev`: `npm run lint && npm run typecheck && npm run test && npm run build`.
2. `npm version X.Y.0 --no-git-tag-version`; add a `## [X.Y.0]` section to `CHANGELOG.md`
   (features + deploy checklist: new migrations, new env vars, dashboard steps + known issues).
3. Commit `chore(release): vX.Y.0`, PR `dev` → `main`, merge (merge commit, not squash) after CI is green.
4. Cut the branch: `git checkout main && git pull && git checkout -b release/X.Y && git push -u origin release/X.Y`.
5. Tag on it: `git tag -a vX.Y.0 -m "Release vX.Y.0" && git push origin vX.Y.0`
   → `release.yml` pushes `mingming21400/ricotdin:vX.Y.0` (+ `:latest` if highest) and opens
   PR `ricotdin vX.Y.0` on `mmlabs-online/deployment` (OPS-04, see Deploy below).
6. Create the GitHub Release from the `CHANGELOG.md` section.

**Hotfix `X.Y.(Z+1)` for an existing line:**
1. Branch from `release/X.Y` (e.g. `hotfix/<topic>`), fix + test, bump version, add CHANGELOG entry.
2. PR into `release/X.Y`; after merge, tag `vX.Y.(Z+1)` on `release/X.Y` and push the tag.
3. Merge `release/X.Y` back into `main` and `dev` so the fix is not lost in the next release.
   `ricotdin:latest` only moves when the pushed tag is the highest version, so a hotfix on
   an old line never drags `latest` backwards.

**Deploy = merge the deployment PR (OPS-04):** image `mingming21400/ricotdin`, tags are
v-prefixed (`vX.Y.Z`). After `verify` passes, `release.yml` builds + pushes the image, then
(secret `DEPLOY_REPO_TOKEN` — fine-grained PAT on `mmlabs-online/deployment` only, Contents +
Pull requests RW) opens PR `ricotdin vX.Y.Z` on `mmlabs-online/deployment` that writes ONLY
`apps/ricotdin/release.env`:
`RICOTDIN_IMAGE=mingming21400/ricotdin:vX.Y.Z@<digest>` (pinned by digest) + `RICOTDIN_VERSION=vX.Y.Z`.
Reviewing + merging that PR deploys to the home server (deployment-repo side = OPS-05).
The tag is never baked into the image; runtime `RICOTDIN_VERSION` (non-secret) is served by
public `GET /version.json` (fallback: baked `BUILD_COMMIT`, then `"unknown"` —
`lib/release/version.ts`). Public `GET /api/health` → `{"status":"ok"}` (no DB/provider calls)
backs the image `HEALTHCHECK`. Never deploy `dev` or `latest`. Apply that release's new
migrations BEFORE merging the deployment PR. Rollback = a deployment PR pinning the previous
release's digest (only safe if no destructive migration ran in between).

## 9l. Traceability (feature / bug ↔ branch ↔ commit ↔ PR)

Tickets live **in the repo only** — no GitHub Issues. Features: `ai-instruction/tracking.md`
(`ABC-12`). Bugs: `ai-instruction/bugs.md` (`BUG-NNN`). Linking is by convention (no CI check);
the `/add-feature`, `/ship-feature` and `/fix-bug` skills apply it automatically.

| Artifact | Convention |
|---|---|
| Branch | `feat/<CODE>-<slug>` · `fix/BUG-NNN-<slug>` (from `dev`) · `hotfix/BUG-NNN-<slug>` (from `release/X.Y`) · `docs/<CODE>-<slug>` |
| Commit | Conventional Commits with the code at the end: `feat(rag): folder export (RAG-05)`, `fix(quota): no double charge (BUG-004)` |
| PR title | `[<CODE>] <summary>`; body from `.github/pull_request_template.md` |
| Release PR | `chore(release): vX.Y.Z`; body lists every code included (command below) |
| CHANGELOG | each bullet ends with its code(s): `- … (PRO-09)` |
| Back-link | after a PR is opened, add `PR #N` to the Note cell in `tracking.md` / the Link cell in `bugs.md` |

Look-ups:
```
git log --oneline --grep 'PRO-09'                         # commits for a code
gh pr list --state all --search 'PRO-09 in:title'          # PRs for a code
git log main..dev --format=%s | grep -oE '\b[A-Z]+-[0-9]+\b' | sort -u   # codes in the next release
```

## 9a. Manual Supabase dashboard actions required

Before Phase 2 features work end-to-end, you must do the following once in the
Supabase dashboard:

1. **Create a private Storage bucket named `recordings`**
   - Dashboard → Storage → New bucket → Name: `recordings` → uncheck "Public bucket" → Save
   - The server route checks for this bucket on every upload and returns 503 with a
     clear message if it is missing.

2. ~~**Enable Anonymous sign-ins**~~ **Phase 7 complete — disable this now.**
   - Dashboard → Authentication → Providers → Anonymous sign-ins → **Disable**
   - Real email+password auth is in place. Existing anonymous-user test data is
     orphaned — wipe it with `DELETE FROM auth.users WHERE is_anonymous = true`.

3. **Apply Phase 7 migrations** (run in the SQL editor in order):
   - `migrations/001_profiles.sql` — profiles table + RLS + role-escalation trigger
   - `migrations/002_jwt_hook.sql` — custom access token hook function
   - `migrations/003_rls_owner_or_admin.sql` — owner-or-admin RLS on all tables
   - Then: Dashboard → Authentication → Hooks → Custom Access Token →
     select `public.custom_access_token_hook` and save.

4. **Apply Phase 8 migration:**
   - `migrations/004_meetings_pinned.sql` — adds `pinned_at` column + sort index to `meetings`.

5. **Apply Phase 13 migration:**
   - `migrations/014_provider_keys.sql` — provider_keys table (AES-256-GCM encrypted key pool).
   - Before running: set `KEY_ENCRYPTION_SECRET` in `.env.local` (64 hex chars; generate with
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
   - After applying: add keys via `/admin/keys` UI; env-var keys continue to work as fallback.

5. **Apply Phase 14 migration:**
   - `migrations/016_activity_log.sql` — adds `activity_log` table (admin-read RLS, service-role writes, 4 indexes).

6. **Apply Phase 12 migrations** (run in the SQL editor IN ORDER — 011, 012, 013):
   - `migrations/011_folders.sql` — `folders` table + `meetings.folder_id` FK + owner-only RLS.
   - `migrations/012_folder_shares.sql` — `folder_shares` table + `can_access_meeting()` SQL function
     + updated per-verb RLS on all meeting-related tables and `folders`. Must run AFTER 011.
   - `migrations/013_folders_position.sql` — `position` column on `folders` for drag-and-drop ordering.

7. **Apply AIP-06 + storage-config migrations:**
   - `migrations/027_model_control.sql` — `app_settings` table (model allow-list + system default) + `profiles.default_provider/model`.
   - `migrations/028_storage_config.sql` — `storage_config` table (admin-managed R2 credentials; secret AES-256-GCM encrypted).
     After applying, configure R2 at `/admin/storage`. R2 is DB-configured only — there is no `R2_*` env-var fallback.
     Requires `KEY_ENCRYPTION_SECRET` (same secret used for API keys) to encrypt/decrypt the secret access key.

8. **Apply API key health-check migration:**
   - `migrations/029_admin_config_health.sql` — adds `health_status` / `health_checked_at` / `health_detail`
     to `admin_config`. Powers the key health check on `/admin/keys` (see §9i). No env/config prerequisites.

9. **Apply audio-render flag migration:**
   - `migrations/031_audio_render_hack_flag.sql` — seeds the `user_hack_audio_render` row in `app_config`
     (default `false`). Toggle it at `/admin/config`. See §9j.

## 9i. API key health check design

**Goal:** Detect dead/revoked provider keys (the `key #N rejected with 401 — permanently disabled` case)
before they break a user request. Surfaced on `/admin/keys`.

- **Probe:** a cheap authenticated request per provider using the decrypted key.
  Gemini/OpenAI `GET /models`, Speechmatics `GET /v2/jobs?limit=1` (free — list resources).
  Gemini carries the key as a query param; the others use `Authorization: Bearer`.
  **Grok (xAI) is special:** xAI keys use per-endpoint ACLs and by default lack the
  `api-key:endpoint:models` ACL, so `GET /v1/models` returns a misleading 403 for keys that
  work fine for chat. Grok is therefore probed with a minimal `POST /v1/chat/completions`
  (`max_tokens: 1`, model `grok-3-mini`) — the endpoint the app actually uses — so the verdict
  reflects real usability. Costs ~1 output token per check. `ProbeConfig` supports `method`/`body`.
- **Verdict** (`lib/keys/healthcheck.ts`, pure + tested in `tests/key-healthcheck.test.ts`):
  2xx/429 → `healthy` (429 = valid but rate-limited); 401/403 → `unhealthy`; 5xx/other/network → `unknown`.
  A decrypt failure (KEY_ENCRYPTION_SECRET mismatch) is recorded as `unhealthy`.
- **Runner** (`lib/keys/healthcheck-runner.ts`, server-only): loads all `admin_config` key rows
  (active + disabled), decrypts in-memory, probes, writes `health_status/detail/health_checked_at`.
  Plaintext/ciphertext are never logged or returned.
- **Automation:** `lib/keys/healthScheduler.ts` — in-process daily scheduler started from
  `instrumentation.ts` (single `next start` process, no external cron). Runs on startup only if the
  last recorded run is stale (>24h), then every 24h. Timer is `unref()`ed.
- **Manual trigger:** `POST /api/admin/keys/healthcheck` (admin; audit-logged `admin_config.healthcheck`).
  `GET` returns the last run timestamp. `GET /api/admin/keys` now returns the health columns.
- **UI:** `/admin/keys` shows a Health badge + hover detail per key, a "Run health check now" button,
  and the latest run time (`= max(health_checked_at)`). Env-var fallback keys are not rows, so they
  are not health-checked.

## 9j. Audio seek / `user_hack_audio_render` flag

**Problem:** browser recordings come from `MediaRecorder` as **live-mode WebM/Opus**
(`lib/audio/support.ts`) and are uploaded byte-for-byte to R2 (`lib/upload/upload.ts`).
A live-mode WebM has an *unknown* Duration in its Segment Info header and **no Cues**
(seek index). So in `<audio>`: `duration === Infinity`, no total length is displayed,
there is no time→byte map for a Range seek, and the scrub bar only covers already-buffered
bytes. The `43m 46s` shown in the meeting header comes from `meetings.duration_seconds`
(client-measured at record time), **not** from the audio file. Uploaded mp3/m4a files are
unaffected — they seek normally.

**Mitigation (this flag, NOT a cure):** `app_config.user_hack_audio_render` (migration 031,
default `false`). When on, the player seeks once to `HACK_SEEK_TARGET` (`1e101`) after
`loadedmetadata`; the media engine scans to end-of-stream, fires `durationchange` with a real
duration, and exposes a full seekable range. The playhead is then restored.
**Cost: the entire file is downloaded up front.** Leave it off unless users complain about
seeking; the durable fix is remuxing on upload into a container with Duration + Cues
(ffmpeg is already a dependency — see `lib/audio/transcode.ts`). Remux is not built.

- Pure logic: `lib/audio/durationFix.ts` — `needsDurationFix`, `isRecoveredDuration`,
  `shouldRunDurationFix`, `resolveDuration`, `HACK_SEEK_TARGET`. Tested in
  `tests/audio-duration-fix.test.ts`.
- Client hook: `lib/audio/useAudioDurationFix.ts` — arms once per source; no-op when the file
  is already seekable, so turning the flag on is safe for mp3/m4a meetings.
- Flag delivery: `app_config` is admin-SELECT under RLS, so the browser can never read it.
  `GET /api/audio-url/:id` resolves it server-side (service role) and returns
  `{ url, hackAudioRender }` — no extra round-trip.
- Server reader: `lib/config/appConfig.ts` — `getAppConfigBool(key, fallback)`, 30s TTL cache,
  `invalidateAppConfigCache()` called from `PATCH /api/admin/config/:key` for immediate effect.
  A failed lookup returns the caller's fallback; a malformed value never flips a flag on
  (`coerceConfigBool` in `lib/admin/config.ts`).

## 9b. Auth/roles — Phase 7 design

**Role storage (NEVER in user_metadata):**
- Role is stored in `auth.users.app_metadata.role` (service-role-writable only).
- Also mirrored in `public.profiles.role` (display/join; kept in sync by server routes).
- `user_metadata` is user-writable via the SDK → NEVER store role there.

**JWT claim injection:**
- `migrations/002_jwt_hook.sql` registers `public.custom_access_token_hook`.
- The hook copies `app_metadata.role` → `user_role` JWT claim on every token issue.
- RLS policies read `auth.jwt()->>'user_role'` (no per-query subquery).
- Dashboard step: Authentication → Hooks → Custom Access Token → enable the function.

**Username → email login flow (server-side only):**
- `POST /api/auth/login` accepts `{ identifier, password }`.
- If `identifier` contains `@` → treat as email.
- Otherwise → service-role lookup: `profiles WHERE username = normalize(identifier)`,
  then `auth.admin.getUserById(profile.id)` to get the email.
- `signInWithPassword(resolvedEmail, password)` is called on the server.
- The mapping is NEVER exposed to the client; generic errors are returned on failure.

**Registration (email verification required):**
- `POST /api/auth/register` creates the user via `auth.admin.createUser` with
  `app_metadata: { role: 'user' }` and **`email_confirm: false`**. Client cannot choose a role.
- Profile row is inserted immediately after; on failure the auth user is cleaned up.
- Verification email is sent via the anon client `auth.resend({ type: 'signup', email,
  options: { emailRedirectTo: '<origin>/login' } })` — `admin.createUser` never sends mail
  itself. Returns `{ verifyEmail: true, emailSent: boolean }`.
- **No admin-approval gate** (the old auto-ban on signup was removed). The user can sign in
  as soon as they click the verification link; it lands on `/login` and the browser client
  picks up the session from the URL (`detectSessionInUrl`).
- `POST /api/auth/login` maps the Supabase `email_not_confirmed` error to a 403 with a
  "verify your email" message. A `user_banned` error now means an admin-disabled account.
- **Dashboard prerequisite:** Authentication → Providers → Email → "Confirm email" ON, and
  SMTP configured (Authentication → Emails / SMTP). Without SMTP no verification mail is sent.

**RLS: OWNER-OR-ADMIN:**
- All tables use `auth.uid() = owner_id OR auth.jwt()->>'user_role' = 'admin'`.
- Server pipeline still uses the service role key (bypasses RLS entirely).

**Admin seed script:**
```
npx tsx scripts/seed-admin.ts <email>
```
Reads `.env.local`, sets `app_metadata.role='admin'` and syncs `profiles.role`.
Run once for the first admin account; use `/admin` UI for subsequent changes.

**Column-level privilege:**
`REVOKE UPDATE ON profiles FROM authenticated; GRANT UPDATE(username) ON profiles TO authenticated;`
Normal users literally cannot UPDATE the `role` column from the browser.
The `prevent_role_escalation` trigger is a belt-and-suspenders backup.

## 9c. Admin user-management design (Phase 9)

All operations use the **Supabase Auth Admin API** (`auth.admin.*`) with the **service
role key** (server-side only). `auth.users` is not queryable from the browser.

**Endpoints:**
- `GET /api/admin/users?page&perPage&search` — paginated list with email, username, role,
  disabled (banned) + `status`, meeting_count, last_sign_in_at, created_at. Up to 1000 users
  fetched from Admin API; search + pagination applied server-side.
  - **`status` is a 3-way derived value** (`lib/admin/userStatus.ts` → `deriveUserStatus`, pure +
    tested in `tests/user-status.test.ts`): `disabled` (banned_until in future) takes precedence;
    else `unverified` (email_confirmed_at null — signed up, not yet verified); else `active`.
    The admin list/detail UI shows an Unverified / Active / Disabled badge + status filter.
    NEVER conflate "unverified" with "disabled" — they are different signals (email_confirmed_at
    vs banned_until).
- `PATCH /api/admin/users/:id/role` — change role to `'user'` or `'admin'`.
- `PATCH /api/admin/users/:id/status` — `{ disabled: boolean }` → enable/disable via
  `ban_duration = '876600h'` (disable) or `'none'` (enable).
- `POST /api/admin/users/:id/reset-password` — `auth.admin.generateLink({ type: 'recovery' })`
  triggers a recovery email. Requires SMTP configured in Supabase project settings.
  Does NOT set a password directly.
- `DELETE /api/admin/users/:id` — collects `audio_path` from all user meetings, deletes
  Storage objects (service role), then `auth.admin.deleteUser()`. DB rows cascade.

**Role sync rule:** every role change must update BOTH:
1. `auth.users.app_metadata.role` (Admin API → JWT source of truth)
2. `public.profiles.role` (display table)
Do not update one without the other. If the auth update succeeds but profiles sync fails,
log a warning (app_metadata is authoritative; profiles will be corrected on next change).

**Role change timing:** the new role takes effect on the target user's **next token
refresh**. There is an inherent delay; advise the user to sign out and back in to see
their new role reflected immediately.

**Guards** (pure functions in `lib/admin/guards.ts`, tested in `tests/admin-guards.test.ts`):
- `checkAdminRole(appMetadata)` — used by `requireAdmin`; returns `false` → HTTP 403.
- Self-action: admins cannot demote, disable, or delete **themselves**.
- Last-admin: cannot demote, disable, or delete the **last remaining admin**.
  Admin count is read from `profiles WHERE role = 'admin'` (kept in sync).

**Storage cleanup on user delete:**
Before `auth.admin.deleteUser`, gather all `meetings.audio_path` for the target user
and call `storage.from('recordings').remove(paths)`. Storage failures are logged and
returned as `storageWarnings[]` but never abort the user delete. DB rows cascade via
the `auth.users → profiles` and `auth.users → meetings` FK `ON DELETE CASCADE`.

**UI at `/admin`:**
- Shows current admin's row with a "You" badge; self-action buttons are disabled.
- Client-side search by email/username; pagination at 20 per page.
- Role change and status toggle are optimistic with revert on error.
- Delete and password-reset open confirmation dialogs before running.
- Global success/error banners with dismiss.

## 9e. AI provider usage tracking design (Phase 10b)

**Schema (`migrations/009_usage_log.sql`) — unit-aware, never conflate units:**
```
usage_log: id, created_at, provider, model, operation,
           input_tokens int null, output_tokens int null, total_tokens int null,
           audio_seconds numeric null,
           unit text ('tokens' | 'audio_seconds'),   ← primary metering unit
           quantity numeric,                          ← total_tokens OR audio_seconds
           status text ('ok'|'rate_limited'|'error'), http_code int null,
           meeting_id uuid null, user_id uuid null
```
RLS: admin SELECT only; writes via service role. 5 indexes (created_at, provider+model, operation, meeting_id, status).

**KEY RULE: NEVER aggregate `quantity` across different `unit` values.** Tokens and audio-seconds are incommensurable. Always filter by `unit` before summing.

**Central helper — `lib/usage/logUsage.ts`:**
- `logUsage(UsageEntry): void` — fire-and-forget; a logging failure NEVER breaks the real call.
- Called immediately after every AI provider request (success, rate-limit, or error).
- Normalises to `{ unit, quantity }` based on the entry type.

**Instrumentation points (optional `ctx?: { meetingId?, userId? }` added to each):**
- `lib/gemini/analyze.ts` → `analyzeTranscript(transcript, date?, ctx?)` — logs after each `generateContent` (including the strict-prompt retry), reads `response.usageMetadata` for `promptTokenCount` / `candidatesTokenCount` / `totalTokenCount`.
- `lib/gemini/embed.ts` → `embedChunks(texts, ctx?)` — logs after each batch; reads `usageMetadata` if present, falls back to `batch.length` as quantity proxy. `operation` can be `'embed'` (pipeline) or `'embed-query'` (RAG retrieval).
- `lib/gemini/answer.ts` → `answerWithContext({ …, ctx? })` — logs after `generateContent`.
- `lib/speechmatics/transcribe.ts` → `transcribeWithSpeechmatics(path, ctx?)` — logs after transcript is received; `audio_seconds = max(result.end_time)` across all raw transcript results.
- `lib/rag/retrieve.ts` → forwards `userId` to `embedChunks` as `embed-query` context.
- `lib/pipeline/processMeeting.ts` → extracts `user_id` from the claim and passes `usageCtx` to all three provider calls.
- `app/api/chat/route.ts` → passes `{ meetingId, userId }` as `usageCtx` to `retrieveContext` and `answerWithContext`.

**Admin API — `GET /api/admin/ai-usage?from=&to=&groupBy=`:**
- Server-enforced by `requireAdmin`.
- `from`/`to` = ISO 8601 (defaults: last 30 days → now).
- `groupBy=operation` further splits by operation (default: provider+model+unit only).
- Fetches filtered rows then aggregates in JS (safe for expected row counts).
- Response: `{ from, to, rows: AiUsageRow[], dailyTotals: DailyTotal[] }`.
- `AiUsageRow`: provider, model, operation (if grouped), unit, calls, total_tokens, total_input_tokens, total_output_tokens, total_audio_seconds, rate_limited_count, error_count.
- `DailyTotal`: date (YYYY-MM-DD), provider, unit, quantity — for the trend chart.

**UI at `/admin/usage` (extended, not a new page):**
- New "AI Provider Usage" section at top; existing meeting/storage sections below.
- Date-range selector (from/to inputs) + "Break down by operation" checkbox + Apply button.
- Summary tiles: Gemini calls, total/input/output tokens, STT calls, audio transcribed, 429s, errors.
- Two separate tables: "Token-metered (Gemini)" and "Audio-metered (Speechmatics)" — unit-separated.
- SVG bar chart (no external chart lib): one bar per day, stacked per provider, tooltips, per-unit chart (tokens vs audio_seconds rendered separately).
- Provider colour legend. Rate-limited/error counts highlighted in amber/red.

**Tests (`tests/usage-log.test.ts`, 14 assertions, all pure):**
- Admin guard returns 403 for non-admins.
- Token-unit row: correct field population (input/output/total tokens, null audio_seconds).
- Audio-seconds-unit row: correct field population (audio_seconds, null token fields).
- Aggregation: correct per-unit sums; tokens/audio_seconds never bleed across unit groups.

## 9f. Provider API key pool design (Phase 13 / SEC-04)

**Goal:** Admins can manage Gemini and Speechmatics API keys from a UI. Keys are never stored in plaintext. The UI is write-only (keys cannot be read back).

**Schema (`migrations/014_provider_keys.sql`):**
```
provider_keys: id, created_at, updated_at, provider ('gemini'|'speechmatics'),
               label (display name, max 80 chars),
               key_ciphertext (base64), key_iv (base64), key_auth_tag (base64),
               last4 (last 4 chars of plaintext key, display only),
               status ('active'|'disabled'), disabled_reason text null,
               last_used_at timestamptz null, created_by uuid null
```
RLS: admin SELECT only (metadata, never ciphertext); all writes use service-role client.

**SECURITY RULES (absolute):**
- `key_ciphertext`, `key_iv`, `key_auth_tag` are NEVER returned in any API response, ever.
- `KEY_ENCRYPTION_SECRET` (server env var, 32 bytes) is NEVER logged, never sent to client.
- Decrypted keys exist ONLY in server-side memory at call time.
- Losing `KEY_ENCRYPTION_SECRET` makes all stored DB keys unrecoverable.
- Every key mutation (create/disable/enable/delete) writes an audit log entry with only `{ provider, label }` in metadata — never ciphertext or plaintext.

**Crypto (`lib/crypto/index.ts`):**
- AES-256-GCM with a random 12-byte IV per encryption. Returns `{ ciphertext, iv, authTag }` (all base64).
- `encryptSecretWithKey(plaintext, key: Buffer)` / `decryptSecretWithKey(secret, key: Buffer)` — pure, accept explicit key buffer (unit-testable).
- `encryptSecret(plaintext)` / `decryptSecret(secret)` — public API; read `KEY_ENCRYPTION_SECRET` from env.

**Pure helpers (`lib/keys/guards.ts`):**
- `isLastActiveKey(activeCount: number): boolean` — returns true when activeCount ≤ 1; blocks disable/delete of last active key.
- `maskProviderKey(row: ProviderKeyRow): MaskedProviderKey` — strips ciphertext/IV/tag/created_by; safe to return.

**Key provider (`lib/keys/provider.ts`):**
- `getActiveKeys(provider): Promise<string[]>` — queries DB, decrypts, caches 30s; falls back to env vars if no DB keys.
- `invalidateKeyCache(provider?)` — called after mutations for immediate effect.
- Env fallback: Gemini reads GEMINI_API_KEYS, GEMINI_API_KEY_1..20, GEMINI_API_KEY; Speechmatics reads SPEECHMATICS_API_KEY.

**Provider wiring:**
- `lib/gemini/pool.ts` — async `getPoolAsync()` with 30s TTL refresh; `resetGeminiPool()` for forced invalidation.
- `lib/speechmatics/client.ts` — async `getApiKey()` via `getActiveKeys('speechmatics')`.

**Admin API (all requireAdmin, service-role client):**
- `GET /api/admin/keys` — list all keys (SAFE_SELECT only — never ciphertext).
- `POST /api/admin/keys` — accepts `{ provider, label, key }` — encrypts, inserts, returns masked record, invalidates cache.
- `PATCH /api/admin/keys/:id` — `{ status, disabled_reason? }` — last-active-key guard on disable.
- `DELETE /api/admin/keys/:id` — last-active-key guard on active key.

**UI at `/admin/keys`:**
- Per-provider table: label, `••••last4`, status badge, last_used_at. Disable/Enable + Delete buttons.
- Add form: provider dropdown, label input, key password input (write-only). On success: one-time "Key saved. It cannot be viewed again." message.
- Disable and delete have confirmation dialogs. "Keys" added to admin sidebar nav (Key icon).

**Tests (`tests/provider-keys.test.ts`, 16 assertions, all pure):**
- Round-trip encrypt/decrypt; different IV each call; tampered ciphertext/tag/wrong-key all throw; invalid key length throws.
- `isLastActiveKey` edge cases.
- `maskProviderKey` never exposes sensitive fields; JSON serialization clean.

## 9g. User activity log design (Phase 14)

**Purpose:** High-volume per-user event log for behavioural observability.
Distinct from `audit_logs` (which records rare admin actions) — this records
normal user activity. Viewable by admins only; writes via service-role.

**Schema (`migrations/016_activity_log.sql`):**
```
activity_log: id, created_at, user_id (NOT NULL → auth.users ON DELETE CASCADE),
              event_type text NOT NULL, meeting_id uuid NULL (ON DELETE SET NULL),
              target_user_id uuid NULL (ON DELETE SET NULL), metadata jsonb NULL,
              ip text NULL, user_agent text NULL
```
RLS: admin SELECT only (`auth.jwt()->>'user_role' = 'admin'`); all inserts use service-role.
Indexes: (user_id, created_at DESC), (event_type, created_at DESC), (created_at DESC), (meeting_id) WHERE NOT NULL.

**Allowed event types (ALLOWED_EVENT_TYPES in `lib/activity/types.ts`):**
- Auth: `login`, `logout`
- Recording (client best-effort): `record_start`, `record_stop`
- Meeting lifecycle (server): `meeting_created`, `processing_done`, `processing_failed`, `chat_message`, `meeting_deleted`
- Sharing (schema ready, instrumentation TODO): `meeting_shared`, `meeting_unshared`
- `meeting_viewed` is **intentionally absent** — too noisy, low value. Enforced by test regression guard.

**Instrumentation points:**
- `app/api/auth/login/route.ts` → `login` event after successful `signInWithPassword`
- `app/api/auth/logout/route.ts` → `logout` event (best-effort hook; client calls before clearing session)
- `app/api/meetings/route.ts` (POST) → `meeting_created` after insert
- `lib/pipeline/processMeeting.ts` → `processing_done` / `processing_failed`
- `app/api/chat/route.ts` (POST) → `chat_message` after user message persisted (no content in metadata)
- `app/api/meetings/[id]/route.ts` (DELETE) → `meeting_deleted` after row delete
- `app/api/activity` (POST) → browser hook: `record_start`, `record_stop` only

**Central helper (`lib/activity/logActivity.ts`):**
- `logActivity(ActivityEntry): void` — fire-and-forget; uses service-role client; never throws; never blocks caller.

**Pure helper modules (TDD, no I/O):**
- `lib/activity/types.ts` — `ALLOWED_EVENT_TYPES`, `CLIENT_EVENT_TYPES`, `ActivityEventType`, `validateEventType()`
- `lib/activity/parse.ts` — `parseActivityQueryParams(URLSearchParams)` → `{ page, perPage, userId, eventType, from, to }`
- `lib/activity/guards.ts` — `isCallerOwn(callerUserId, requestedUserId): boolean`

**Endpoints:**
- `POST /api/activity` — browser hook; accepts only CLIENT_EVENT_TYPES (`record_start`, `record_stop`); validates `isCallerOwn`; in-memory rate limit 10/user/minute. Returns 422 for non-client event types, 403 for cross-user logging.
- `GET /api/admin/activity?userId=&eventType=&from=&to=&page=&perPage=` — admin-only paginated feed; joins `meetings(title)` (no content); returns `{ rows, total, page, perPage }`.

**UI:**
- `/admin/users/[id]` — "Activity" tab shows user's activity_log events (replaces previous audit_logs tab).
- `/admin/activity` — global feed page with filters (userId, eventType, date range) + pagination. Linked from admin sidebar ("Activity" / History icon).

**SECURITY guardrails (non-negotiable):**
- Metadata NEVER contains meeting content (transcript/notes/summary). Only identifiers and counts.
- `meeting_viewed` MUST NEVER be added — regression test guards the ALLOWED_EVENT_TYPES set.
- Client endpoint (`POST /api/activity`) restricted to caller's own userId + rate-limited.
- Admin endpoints: `requireAdmin` server-enforced; non-admins get 403.
- Logging is fire-and-forget — a DB failure is logged to console only, never surfaces to users.

**Tests (`tests/activity-log.test.ts`, covers pure helpers):**
- `validateEventType`: all 11 allowed types accepted; unknown + empty rejected.
- `meeting_viewed` regression guard: absent from ALLOWED_EVENT_TYPES + validateEventType returns false.
- `parseActivityQueryParams`: defaults, parsing, clamping (page ≥ 1, perPage ≤ 100).
- `isCallerOwn`: match → true; mismatch → false; empty requestedUserId → false.

## 9h. Feature registry design (Phase 15)

**Concept:** The files in `ai-instruction/features/` are read ONE TIME (by the seeder) to populate a DB table. After seeding, the **database is the single source of truth**. All runtime code reads/writes the DB only — no filesystem reads at runtime, no static imports of those files.

**Schema (`migrations/017_features.sql`):**
```
features: id, created_at, updated_at, updated_by (text),
          key text UNIQUE (e.g. 'REC-01'),
          source_path (original file path, for reference),
          module_prefix text, module_name text (denormalized),
          title text, user_story text, description text,
          content text (full markdown body of the feature section),
          status text CHECK ('done'|'partial'|'not_started'),
          priority text CHECK ('high'|'medium'|'low'|null),
          note_tags text[], depends_on text[], blocks text[],
          key_files text[], metadata jsonb, change_note text
```
RLS: admin SELECT only; all writes via service-role client.
Auto-bump trigger on updated_at.

**Seeder (`scripts/seed-features.ts`) — THE ONLY PLACE FILES ARE READ:**
- Reads `ai-instruction/features/*.md` (module files) + `ai-instruction/tracking.md`.
- Parsing logic lives in `lib/features/parser.ts` as pure functions (testable).
- `tracking.md` is authoritative for is_done status and description.
- UPSERTs by `key` — idempotent; re-running is safe.
- Reports: N features processed (X inserted, Y updated).
- Run once: `npx tsx scripts/seed-features.ts`
- Adding a feature later: `npx tsx scripts/seed-features.ts --only <KEY>[,<KEY>]` upserts just
  those keys (`lib/features/seedFilter.ts`, tested in `tests/features-seed-filter.test.ts`).
  A full re-run overwrites every edit made at `/admin/features` — never do that after seeding.

**Pure parser (`lib/features/parser.ts`):**
- `parseStatus(raw)` — maps ✅/❌/⚠️ or [x] to enum.
- `parseFeatureSection(key, title, body)` — extracts status, user_story, content.
- `parseModuleFile(rawMarkdown, sourcePath)` — parses all `### PREFIX-NN` sections.
- `parseTrackingMd(rawMarkdown)` — parses tracking.md table into a Map.
- `mergeWithTracking(feature, trackingRow)` — merges file + tracking data; tracking wins for is_done.

**DB-access service (`lib/features/index.ts`, server-only, no filesystem):**
- `listFeatures(filters?)` — list with module_prefix/status/search/page filters.
- `getFeature(key)` — fetch by key (e.g. 'REC-01').
- `updateFeature(id, fields, updatedBy)` — persist edits.

**Admin API (all `requireAdmin`):**
- `GET /api/admin/features` — list.
- `GET /api/admin/features/:id` — detail (accepts UUID or key).
- `PATCH /api/admin/features/:id` — edit; writes one `audit_logs` row (`action: 'feature.update', metadata: { key, changed_fields }`).

**UI at `/admin/features`:**
- Split-pane: left = filterable/searchable list grouped by module_prefix; right = edit panel for selected feature.
- Editable: status, priority, title, description, note_tags, depends_on, key_files, content (markdown textarea), change_note.
- "Features" (Layers icon) added to admin sidebar nav.

**Tests (`tests/features.test.ts`, 33 assertions, all pure):**
- `parseStatus`: all three values + edge cases.
- `parseFeatureSection`: status, user_story, content extraction.
- `parseModuleFile`: feature count, module metadata, key_files, source_path.
- `parseTrackingMd`: is_done, depends_on, note_tags, priority, description.
- `mergeWithTracking`: tracking wins for done, partial preserved, fallback to tracking user_story.

**ai-instruction/ directory after seeding:**
Kept as a static reference for human reading. NOT read at runtime. No runtime code imports from it. If features need to be updated, edit them in the DB at `/admin/features`.

## 9d. Admin pipeline monitor design (Phase 10a)

**Endpoints (all server-enforced by `requireAdmin`):**
- `GET /api/admin/pipeline/overview` — aggregate counts (pending/processing/done/failed/stuck) + avg_processing_secs for done meetings. Fetches all `meetings.status + created_at + updated_at` and computes in JS (service role, no RLS).
- `GET /api/admin/pipeline/jobs?status=&page=&perPage=` — metadata-only paginated list: id, title, status, created_at, updated_at, duration_seconds, error_message, owner_email, owner_username. `status=stuck` = processing older than 15 min. Never exposes summary/notes/transcript content.
- `POST /api/admin/pipeline/:id/requeue` — safe re-run for failed/stuck meetings. Steps: (1) verify status is failed or processing, (2) delete transcript_segments + todos + calendar_suggestions (transcript_chunks cascade), (3) reset meetings.status='pending' + clear error_message/summary/notes/language, (4) write `meeting.requeue` audit log, (5) fire `processMeeting()` non-awaited. Returns 422 for pending/done meetings.

**Stuck definition:** `status = 'processing' AND updated_at < now() - 15 minutes`.

**Audit log (migration 005):** `audit_logs` table with actor_id, actor_email, action, target_type, target_id, metadata jsonb, ip_address, user_agent. RLS: admin SELECT only; writes via service role. `lib/admin/audit.ts` exports `writeAuditLog()` (fire-and-forget, never throws) and `requestContext()`.

**UI at `/admin/pipeline`:**
- Status tiles (Pending/Processing/Stuck/Failed/Done + avg duration) — click a tile to filter the table.
- Filter tabs + job table: Status badge, Meeting title/id, Owner email/username, Created (GMT+7), Duration, Error snippet, Requeue button (enabled for failed/stuck only).
- "Requeue all stuck/failed" bulk button with confirmation dialog.
- 10-second auto-poll; re-fetches on filter/page changes.
- Sub-nav links: Users | Pipeline (extensible for Usage + Audit in later phases).

## 10. Working agreement (how to collaborate with me)

- Work in **small increments**, one clear goal per change, each with a concrete
  "done" check. Do not attempt the whole app in one go.
- After each working increment, **commit to git** with a clear message.
- **TDD is mandatory for all new logic:**
  - Write unit tests for every new pure function **before** writing the implementation.
  - Tests go in `tests/` with the `.test.ts` extension and must be added to the
    `npm test` script in `package.json`.
  - When **any existing logic changes**, update the corresponding tests first, then
    change the implementation.
  - Tests must be pure (no I/O, no mocks) — test pure functions extracted into `/lib`.
- **Update `ai-instruction/tracking.md`** when a feature is completed: change `[ ]`
  to `[x]` in the "Is Done?" column for every Feature Code that the work covers.
- Before making large or structural changes, briefly state the plan and wait.
- When you hit an error, surface the exact error/log rather than guessing silently.
- If a request seems to contradict this file (e.g. would expose a key to the client,
  or pull in an out-of-scope feature), flag it instead of just doing it.
- **Feature intake workflow:** to turn a new idea into a tracked feature, use the
  `/add-feature "<idea>"` skill (`.claude/skills/add-feature/SKILL.md`): ground in repo
  (dedupe/scope/code) → brainstorm Q&A → 2–3 options + recommendation → converge on the
  smallest valuable slice that passes a Definition of Ready (testable criteria, test plan,
  structural flags, done check) → approved spec → write `tracking.md` + `features/*.md`
  → `seed-features.ts --only <CODE>`. Docs only, no code.
- **Feature delivery workflow:** to build a feature from `tracking.md`, use the
  `/ship-feature <CODE>` skill (`.claude/skills/ship-feature/SKILL.md`). It sequences
  spec → plan → TDD → implement → verify → specialist review gates (subagents in
  `.claude/agents/`) → close-out, and applies the rules in this section.
- **Bug workflow:** for any bug, regression or production incident, use the
  `/fix-bug "<description>"` skill (`.claude/skills/fix-bug/SKILL.md`). It logs `BUG-NNN` in
  `ai-instruction/bugs.md`, decides bugfix (`dev`) vs hotfix (`release/X.Y`, per §9k) with
  your confirmation, writes a failing regression test first, then fixes, verifies, reviews
  and walks through the §9k hotfix steps.
- **Traceability:** every branch, commit, PR title and CHANGELOG bullet carries its feature
  code or `BUG-NNN` (§9l).
- **Owner copilot:** `/copilot` (status brief), `/copilot <question>`, `/copilot plan`
  (`.claude/skills/copilot/SKILL.md`). Advises and plans only; uses the read-only
  `Project Status Analyst` agent and `scripts/backlog-snapshot.ts` for facts. Strategy and
  decisions persist in `ai-instruction/roadmap.md` (written only with owner approval).

## 11. Build order (current plan)

0. ~~Setup: scaffold Next.js+TS, apply `schema.sql`, verify Supabase + Gemini connectivity.~~ **DONE** (Phase 0 complete — `npm run dev` serves placeholder; `npm run check` verifies both credentials)
1. ~~**Recording** (highest technical risk — validate audio capture first).~~ **DONE** (Phase 1 complete — `/record` page; mic + display audio mixed via Web Audio API; `useRecorder` hook; unsupported-browser + no-system-audio warnings; Chrome/Edge only)
2. ~~**Upload + storage** (presigned URL, `meetings` row).~~ **DONE** (Phase 2 complete — anonymous auth bootstrap; server routes POST /api/meetings + POST /api/meetings/:id/uploaded; direct browser→Storage upload via signed URL; meeting list `/meetings`; placeholder detail `/meetings/[id]`. Requires dashboard: create `recordings` bucket + enable Anonymous sign-ins — see section 9a.)
3. ~~**Processing pipeline** (Gemini service layer, JSON output, chunking, retry, embeddings).~~ **DONE** (Phase 3 complete — transcribeAudio/analyzeTranscript/embedChunks in /lib/gemini; chunkSegments + processMeeting in /lib/pipeline; POST /api/meetings/:id/process trigger; auto-triggered from /uploaded; 3s polling on meetings list; ffmpeg-based long-audio chunking with clear error if ffmpeg absent; 21 unit tests; npm run test configured).
4. ~~**Results UI** (summary / note / transcript / todos).~~ **DONE** (Phase 4 complete — full meeting detail page at `/meetings/[id]`; state machine: loading → inflight (polls 3s) | failed (re-run button) | done; sections: header, audio player via signed URL, summary, markdown notes (react-markdown + rehype-sanitize), todos with optimistic checkbox toggle, calendar suggestions with dismiss, full transcript with speaker-grouped segments and mm:ss timestamps that seek the audio player; chat placeholder. New routes: GET /api/audio-url/:id, PATCH /api/todos/:id, PATCH /api/calendar-suggestions/:id.)
5. ~~**RAG chatbot** (RPC search + grounded answers with citations).~~ **DONE** (Phase 5 complete — full RAG pipeline: `lib/rag/retrieve.ts` embeds query + calls `match_transcript_chunks` RPC with user-scoped client (RLS enforces ownership); `lib/gemini/answer.ts` generates grounded JSON answer with citation validation (invented chunk_ids dropped); `POST /api/chat` route manages sessions + persists messages + streams through the full pipeline; `ChatPanel` component with optimistic UI, citation chips, session history; chat enabled in meeting detail (`/meetings/[id]`); cross-meeting `/chat` page; `Chat` button in meetings list. 12 new unit tests in `tests/rag.test.ts`. New files: `lib/supabase/user-client.ts`, `lib/rag/retrieve.ts`, `lib/gemini/answer.ts`, `app/api/chat/route.ts`, `components/ChatPanel.tsx`, `app/(routes)/chat/page.tsx`.)
6. ~~**Calendar suggestions + todos surfaced in UI** (`.ics` download).~~ **DONE** (Phase 6 complete — pure RFC 5545 ICS builder in `lib/ics/index.ts` (no deps; escaping, folding, UTC); `GET /api/calendar-suggestions/[id]/ics` with ownership check, 422 on null proposed_at (never fabricate a datetime); meeting detail UI: `.ics` download button (fetch+blob with Bearer token) when proposed_at is set, disabled span when null; todo dismiss button (PATCH status=dismissed, optimistic); metadata row always shown with "No due date" when null; past-due date styled orange/amber with ⚠ prefix; helper text on calendar section ("no automatic syncing"); 30 new unit tests in `tests/ics.test.ts`. No Google Calendar OAuth, no auto-creating events, no reminders — post-MVP only.)
7. ~~**Auth, hardening, deploy**~~ **DONE** (Phase 7 complete — email+password registration/login; username-OR-email login (server-side username→email lookup, never exposed to client); two roles: 'user' (default) and 'admin'; role stored ONLY in `app_metadata` + `profiles` table, NEVER in `user_metadata`; custom access token hook injects `user_role` JWT claim for RLS; column-level privilege blocks normal users from changing their own role; belt-and-suspenders trigger `prevent_role_escalation`; `/admin` page with user list, role toggle, ban/unban — all server-enforced (403 for non-admins); `scripts/seed-admin.ts` for initial admin bootstrap; `lib/auth/validate.ts` with 24 unit tests. Dashboard steps: apply migrations 001–003, enable custom access token hook, disable anonymous sign-ins.)
8. ~~**Meeting list actions** (pin, rename, delete)~~ **DONE** (Phase 8 complete — `pinned_at timestamptz null` column on meetings (migration 004) with composite sort index; list sort: pinned-first (most-recently-pinned on top), then created_at desc; per-row pin toggle (📌, optimistic), inline rename (optimistic, Enter to save / Escape to cancel), delete with confirmation dialog ("This permanently deletes the meeting…"); `DELETE /api/meetings/:id` removes audio from Storage before the row delete — Storage failure is logged + warned but does not block the row delete; `PATCH /api/meetings/:id` for rename; `PATCH /api/meetings/:id/pin` for pin toggle; all routes ownership-checked server-side. Apply migration 004 in Supabase dashboard.)
9. ~~**Admin user management**~~ **DONE** (Phase 9 complete — full `/admin` user-management UI + 5 API routes; all routes server-enforced by `requireAdmin` (reads `app_metadata.role`); pure guard functions in `lib/admin/guards.ts` + 21 unit tests; user list with pagination+search+meeting_count+last_sign_in_at; `PATCH /api/admin/users/:id/role` keeps app_metadata+profiles in sync; last-admin guard on demotion/disable/delete; `PATCH /api/admin/users/:id/status` enables/disables via ban_duration; `POST /api/admin/users/:id/reset-password` uses `auth.admin.generateLink({ type: 'recovery' })`; `DELETE /api/admin/users/:id` cleans up Storage audio files before deleting the auth user; UI shows "You" badge on self-row, disables self-action buttons, optimistic role/status updates with revert, confirmation dialogs for delete + password reset. See section 9c for full design.)
10. ~~**Admin operational — Area 1: Pipeline/Job Monitoring**~~ **DONE** (Phase 10a complete — `migrations/005_audit_logs.sql` (admin-readable, service-role writes, 4 indexes); `lib/admin/audit.ts` central `writeAuditLog()` fire-and-forget helper + `requestContext()` IP/UA extractor; `GET /api/admin/pipeline/overview` aggregate counts (pending/processing/done/failed/stuck) + avg_processing_secs; `GET /api/admin/pipeline/jobs?status=&page=&perPage=` metadata-only paginated list with owner email/username — NO transcript/notes content; `POST /api/admin/pipeline/:id/requeue` safe re-run: clears transcript_segments/todos/calendar_suggestions (transcript_chunks cascade), resets status to pending + clears summary/notes/language, writes audit log entry `meeting.requeue`, fires processMeeting() non-awaited; `/admin/pipeline` UI with status tiles (click to filter), filter tabs, jobs table with Requeue button per failed/stuck row, "Requeue all stuck/failed" with confirmation dialog, 10s auto-poll; 11 new unit tests in `tests/admin-pipeline.test.ts` (admin guard 403, requeue eligibility, audit entry structure). Apply migration 005 in Supabase dashboard.)
11. ~~**Admin operational — Area 2: AI Provider Usage Tracking**~~ **DONE** (Phase 10b complete — `migrations/009_usage_log.sql` unit-aware schema (tokens/audio_seconds units never conflated); `lib/usage/logUsage.ts` fire-and-forget central helper; Gemini analyze/embed/answer and Speechmatics all instrumented with optional `ctx?: { meetingId?, userId? }` parameter; processMeeting + chat route pass usageCtx; `GET /api/admin/ai-usage?from=&to=&groupBy=` aggregates in JS; `/admin/usage` page extended with AI usage section: summary tiles, token table + audio table (separate), SVG trend charts per unit, date-range selector; 14 unit tests in `tests/usage-log.test.ts`. Apply migration 009 in Supabase dashboard. See section 9e for full design.)
12. ~~**Shared folders (COM-05 / PRO-06 folders)**~~ **DONE** (Phase 12 complete — `migrations/011_folders.sql` folders table (owner-only RLS, unique name per user, ON DELETE SET NULL for meetings); `migrations/012_folder_shares.sql` folder_shares table + `can_access_meeting(uuid, text)` SQL function as single RLS source-of-truth; per-verb RLS policies replacing FOR ALL on all 9 meeting-related tables + `folders` + `folder_shares`; `lib/access/index.ts` server-side TS helpers (checkMeetingAccess, checkFolderAccess, getMeetingRole, canAssignToFolder) — mirrors SQL function, safe under service-role client; `lib/access/roles.ts` pure client-side helpers (getMeetingRole, canPin, canEdit, canDelete, canManageShares); `GET/POST /api/folders`, `PATCH/DELETE /api/folders/[id]`, `GET/POST /api/folders/[id]/shares`, `PATCH/DELETE /api/folders/[id]/shares/[granteeId]`, `PUT /api/folders/reorder`, `POST /api/users/lookup`; `components/FolderSelector.tsx`; share panel embedded in Manage Folders modal; folder filter pills with 👥 badge for shared folders; `PATCH /api/todos/[id]` and `PATCH /api/calendar-suggestions/[id]` updated to editor+ access via checkMeetingAccess; `GET /api/calendar-suggestions/[id]/ics` updated to viewer+; audio signed-URL route and chat route already used checkMeetingAccess; RAG retrieval scope unchanged (user-scoped client + updated RLS auto-includes shared meetings); 10 unit tests in `tests/folder-shares.test.ts`. Apply migrations 011 then 012 in Supabase dashboard. SEC-03 full RLS review REQUIRED.)
13. ~~**Provider API key management (SEC-04)**~~ **DONE** (Phase 13 complete — `migrations/014_provider_keys.sql` `provider_keys` table (AES-256-GCM encrypted at rest; admin-readable RLS; service-role writes); `lib/crypto/index.ts` AES-256-GCM helpers — `encryptSecretWithKey`/`decryptSecretWithKey` pure (explicit key buffer) + `encryptSecret`/`decryptSecret` (read KEY_ENCRYPTION_SECRET); `lib/keys/guards.ts` pure `isLastActiveKey(count)` + `maskProviderKey(row)` (never exposes ciphertext/IV/tag/created_by); `lib/keys/provider.ts` `getActiveKeys(provider)` async with 30s TTL cache + env-var fallback + `invalidateKeyCache()`; `GET/POST /api/admin/keys` + `PATCH/DELETE /api/admin/keys/:id` — all admin-enforced, never return ciphertext or plaintext, last-active-key guard blocks disable/delete, every mutation audit-logged with `{ provider, label }` only; `lib/gemini/pool.ts` now async with 30s TTL refresh via `getActiveKeys` + `resetGeminiPool()` export; `lib/speechmatics/client.ts` now async via `getActiveKeys`; `/admin/keys` UI with per-provider tables, write-only add form (password input, one-time confirmation), disable/enable toggle with confirm dialog, delete with confirm; "Keys" added to admin sidebar nav (Key icon); 16 unit tests in `tests/provider-keys.test.ts` (crypto round-trip, tamper detection, last-active guard, maskProviderKey security invariants). See section 9f for full design. Apply migration 014 in Supabase dashboard. **IMPORTANT:** Set KEY_ENCRYPTION_SECRET in .env — losing it makes stored keys unrecoverable.)

13. ~~**User activity log (Phase 14)**~~ **DONE** (Phase 14 complete — `migrations/016_activity_log.sql` activity_log table (admin-read RLS, service-role writes, 4 indexes); `lib/activity/types.ts` ALLOWED_EVENT_TYPES set + ActivityEventType + validateEventType() — `meeting_viewed` intentionally absent with regression-test guard; `lib/activity/parse.ts` parseActivityQueryParams() pure parser; `lib/activity/guards.ts` isCallerOwn() pure guard; `lib/activity/logActivity.ts` fire-and-forget central helper (mirrors writeAuditLog pattern); login + logout instrumented; meeting_created, processing_done/failed, chat_message, meeting_deleted all instrumented; `POST /api/activity` client endpoint (record_start/stop only, isCallerOwn guard, 10/min rate limit); `GET /api/admin/activity` admin feed with userId/eventType/from/to filters, meeting title join; `/admin/users/[id]` Activity tab updated to show activity_log data; `/admin/activity` global feed page with filters, pagination, event-type colour badges; "Activity" nav item (History icon) added to admin sidebar; 15 unit tests in `tests/activity-log.test.ts`. Apply migration 016 in Supabase dashboard. See section 9g for full design.)

14. ~~**Feature registry (Phase 15)**~~ **DONE** (Phase 15 complete — `migrations/017_features.sql` features table (UNIQUE key, module_prefix/name, title, user_story, description, content markdown, status/priority/note_tags/depends_on/blocks/key_files arrays, metadata jsonb, updated_by, change_note; admin SELECT RLS; auto-bump trigger); `lib/features/parser.ts` pure parsing functions (parseStatus, parseFeatureSection, parseModuleFile, parseTrackingMd, mergeWithTracking — no I/O, fully tested); `scripts/seed-features.ts` reads ai-instruction/features/*.md + tracking.md ONE TIME and UPSERTs 65 features by key (idempotent); `lib/features/index.ts` DB-access service (listFeatures, getFeature, updateFeature — service-role, no filesystem access); `GET/PATCH /api/admin/features` + `GET/PATCH /api/admin/features/:id` admin-enforced, PATCH writes audit log (action: feature.update); `/admin/features` split-pane UI: grouped filterable list + inline edit panel with all fields + markdown content textarea; "Features" (Layers icon) added to admin sidebar; 33 unit tests in `tests/features.test.ts`. Apply migration 017, then run `npx tsx scripts/seed-features.ts` once. See section 9h for design. After seeding, ai-instruction/features/ is a static reference only — DB is the source of truth.)

**v1.0.0 released** (2026-09-19) — see `CHANGELOG.md`. Audit Log UI (Area 3 / ADM-07) is live at `/admin/audit`.

Keep this section in sync with actual progress; mark phases done as we go.