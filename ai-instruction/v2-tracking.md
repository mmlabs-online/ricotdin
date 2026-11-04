# v2 tracking matrix (ARC-01)

> Defines **parity** for the v2 re-platform: v2 is complete when every row in table (a) is `done` on
> both API and FE (or `n/a`), every row in table (b) is `done` or `dropped`, and every row in table (c)
> is `done`. Specs: `ai-instruction/features/feature-Architecture-ARC.md`. Roadmap: `roadmap.md` 2026-10-25.
>
> **Status values:** `todo` · `in_progress` · `done` · `n/a`. Update the row in the same PR that moves it.
> **ARC** = the ARC feature that ports it. **Tests** = v1 test file(s) in `legacy/tests/` whose cases must be
> ported (pytest for api, vitest for web) — `—` = no v1 test.
> **v2 path convention:** the API is served from its own domain, so paths have **no `/api` prefix**
> (`POST /api/meetings` → `POST /meetings`). Auth: `Authorization: Bearer <access JWT>` (ARC-05).
> Paths marked *(proposed)* are new in v2 and may be refined in their ARC spec; update this file when they change.

---

## (a) Feature parity — every `[x]` feature in `tracking.md` (76)

| Feature | Title | ARC | API endpoints (v2) | API | FE screen | FE | Tests | Note |
|---|---|---|---|---|---|---|---|---|
| REC-01 | Toggle recording & mix sources | ARC-12 | — (browser only) | n/a | Record | done | — | port `lib/audio/capture.ts`, `useRecorder.ts` |
| REC-02 | Audio-only capture | ARC-12 | — (browser only) | n/a | Record | done | — | video track dropped in capture |
| REC-03 | Missing-audio warning | ARC-12 | — (browser only) | n/a | Record | done | — | |
| REC-04 | Browser support | ARC-12 | — (browser only) | n/a | Record | done | — | `lib/audio/support.ts` |
| REC-05 | Upload existing audio file | ARC-07, ARC-12 | `POST /meetings`, `POST /meetings/{id}/uploaded` (ffprobe check) | todo | Record (upload) | done | ffprobe, transcode | 500 MB cap client + server. v1 also accepts **video** uploads (`source='video'`): audio extracted server-side with ffmpeg, original deleted — v2: extracted by the ARC-08 worker (08a), the original video stays in Drive |
| PRP-01 | Audio upload | ARC-07 | `POST /meetings` (presigned R2 PUT), `POST /meetings/{id}/uploaded` | todo | Record | todo | storage-config | browser → R2 direct |
| PRP-02 | Format transcoding | ARC-08 | — (worker) | done | — | n/a | transcode, ffprobe | ffmpeg mono 16 kHz (08a, `app/worker/audio.py`; input guards); Gemini long-audio chunking not ported (owner 2026-11-02) |
| PRP-03 | Transcript generation | ARC-08 | — (worker) | todo | — | n/a | speechmatics, pipeline-parse | |
| PRP-04 | Summary & meeting notes | ARC-08 | — (worker), `POST /meetings/{id}/regenerate` | todo | Meeting detail | todo | pipeline-parse | prompt `ai-instruction/ai-gen/` |
| PRP-05 | Extract to-dos & calendar mentions | ARC-08 | — (worker) | todo | — | n/a | pipeline-parse | |
| PRP-06 | RAG embeddings | ARC-08 | — (worker) | todo | — | n/a | chunk | 768 dims |
| PRP-07 | Processing status & retry | ARC-07, ARC-08 | `GET /meetings/{id}` (status), `POST /meetings/{id}/process` | in_progress | Meetings list, Meeting detail | todo | processMeeting-guard, error-message | API: status + queueing done (ARC-07); `process` queues at most one active job, 30/h per user (ARC-08a); the worker is ARC-08; 0-segment guard |
| PRP-08 | Long-meeting support | ARC-08 | — (worker) | todo | — | n/a | chunk, transcode | |
| MTD-01 | Meeting detail page | ARC-07, ARC-13 | `GET /meetings/{id}`, `GET /meetings/{id}/transcript`, `GET /meetings/{id}/todos`, `GET /meetings/{id}/calendar-suggestions` *(proposed)* | done | Meeting detail | todo | transcript-export | replaces direct Supabase reads (table d) |
| MTD-02 | Audio player | ARC-07, ARC-12 | `GET /meetings/{id}/audio-url` | todo | Meeting detail | todo | audio-duration-fix | `hackAudioRender` flag in response |
| MTD-03 | To-do interaction | ARC-07 | `PATCH /todos/{id}` | done | Meeting detail | todo | — | jump to source segment |
| RAG-01 | Q&A scope | ARC-09 | `POST /chat` (meeting / folder / global scope) | todo | Chat, Meeting detail | todo | rag | |
| RAG-02 | Grounded answers | ARC-09 | `POST /chat` | todo | Chat | todo | rag | "not found" answer |
| RAG-03 | Citations & history | ARC-09 | `POST /chat`, `GET /chat?meetingId=&folderId=` | todo | Chat, Meeting detail | todo | rag | invented chunk ids dropped |
| RAG-04 | Folder-scoped chat | ARC-09 | `POST /chat` (folderId) | todo | Folder view | todo | rag-folder | access-filtered retrieval |
| CAL-01 | Export .ics | ARC-07, ARC-12 | `GET /calendar-suggestions/{id}/ics` | done | Meeting detail | todo | ics | |
| CAL-02 | Truthful time handling | ARC-07 | `GET /calendar-suggestions/{id}/ics` (422 without `proposed_at`) | done | Meeting detail | todo | ics | |
| CAL-03 | To-do management | ARC-07 | `PATCH /todos/{id}`, `PATCH /calendar-suggestions/{id}` | done | Meeting detail | todo | — | |
| MMG-01 | Meeting list | ARC-07 | `GET /meetings` *(proposed)* | done | Meetings list | todo | — | pinned first (`pinned_at DESC NULLS LAST, created_at DESC`); v1 sorts in the browser (`sortMeetings`) — v2 sorts server-side and includes shared-folder meetings |
| MMG-02 | Rename meeting | ARC-07 | `PATCH /meetings/{id}` | done | Meetings list, Meeting detail | todo | — | |
| MMG-03 | Pin meeting | ARC-07 | `PATCH /meetings/{id}/pin` | done | Meetings list | todo | — | |
| MMG-04 | Delete meeting | ARC-07 | `DELETE /meetings/{id}` | todo | Meetings list | todo | retention | audio deleted first, `warning` on failure |
| AUT-01 | Sign up | ARC-05 | `POST /auth/register`, `POST /auth/verify-email` *(proposed)* | todo | Register, Verify email | todo | auth-validate | |
| AUT-02 | Log in | ARC-05 | `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/forgot-password`, `POST /auth/reset-password` *(proposed)* | todo | Sign in, Forgot password, Reset password | in_progress | auth-validate | email or username; reset screens replace Supabase's hosted recovery. FE: Sign in + silent refresh + sign out done (ARC-11); forgot/reset screens ARC-13 |
| AUT-03 | Role authorization | ARC-05, ARC-11 | role claim in access JWT; JWKS `GET /.well-known/jwks.json` *(proposed)* | todo | Route guards | done | admin-guards | FE: `RequireRole` user/admin + return URL (ARC-11, `app/web/src/auth/guards.ts`) |
| AUT-04 | Data isolation | ARC-02, ARC-07 | every meeting-scoped endpoint (app-layer check + RLS backstop) | in_progress | — | n/a | folder-shares | ARC-07 part 1: every endpoint checks access (role matrix test); part 2 adds the storage endpoints; `can_access_meeting` |
| ADM-01 | User list | ARC-10 | `GET /admin/users` | todo | Admin › Users | todo | user-status, admin-guards, admin-adm, usage-by-user | per-user usage column |
| ADM-02 | Account management | ARC-10 | `PATCH /admin/users/{id}/role`, `PATCH /admin/users/{id}/status`, `POST /admin/users/{id}/reset-password`, `DELETE /admin/users/{id}` | todo | Admin › Users | todo | admin-guards, admin-adm | role sync `users.role` + `profiles.role`; the reset email lands on the ARC-05 Reset password screen |
| ADM-03 | Safety constraints | ARC-10 | same as ADM-02 + `POST /admin/users/bulk` | todo | Admin › Users | todo | admin-guards, admin-adm | v1 bulk skips the last-admin guard (only `excludeSelf` protects the caller; a race between two admins remains) — **v2: guard bulk too** (defense in depth) |
| ADM-04 | Pipeline & job monitoring | ARC-10 | `GET /admin/pipeline/overview`, `GET /admin/pipeline/jobs`, `POST /admin/pipeline/{id}/requeue` | todo | Admin › Pipeline | todo | admin-pipeline, admin-adm | |
| ADM-05 | Cost & AI quota monitoring | ARC-10 | `GET /admin/ai-usage`, `GET /admin/usage` | todo | Admin › Usage | todo | usage-log, admin-ext | never mix units |
| ADM-06 | Storage management | ARC-10 | `GET/POST /admin/storage`, `PATCH/DELETE /admin/storage/{id}`, `GET /admin/storage/orphans`, `POST /admin/storage/cleanup` | todo | Admin › Storage | todo | storage-config, admin-ext | |
| ADM-07 | Audit log | ARC-10 | `GET /admin/audit-logs` | todo | Admin › Audit | todo | admin-adm | |
| ADM-08 | System health | ARC-10 | `GET /admin/health` | todo | Admin › Health | todo | admin-ext | |
| ADM-09 | Extended user management | ARC-10 | `GET /admin/users/{id}`, `POST /admin/users/bulk`, `GET /admin/activity` | todo | Admin › Users, User detail | todo | admin-ext, user-status, usage-by-user | |
| ADM-10 | Config & feature flags | ARC-10 | `GET /admin/config`, `PATCH /admin/config/{key}`, `GET/PATCH /admin/generation-config` | todo | Admin › Config | todo | aip-control-plane | |
| PRF-01 | Profile page & account info | ARC-07 | `GET /profile` | in_progress | Profile | todo | — | `avatar_url` is null until ARC-07 part 2 |
| PRF-02 | Edit display name & username | ARC-07 | `PATCH /profile` | done | Profile | todo | auth-validate | username unique |
| PRF-03 | Change password | ARC-05 | `POST /profile/change-password` | todo | Profile | todo | auth-validate | current password required |
| PRF-04 | Avatar upload | ARC-07, ARC-12 | `POST /profile/avatar` (presign) → browser PUT to R2 → `PATCH /profile` (`avatar_key`) | todo | Profile | todo | avatar-key | two steps as in v1; `isOwnedAvatarKey` |
| PRF-05 | Theme configuration | ARC-07, ARC-11 | `PATCH /profile` (`theme_preference`) | done | Profile, app shell | todo | — | v2: one design, light/dark only |
| PRF-08 | Default AI model preference | ARC-07 | `GET/PATCH /profile/preferences` | done | Profile | todo | aip-control-plane, model-label | within admin allow-list |
| REL-01 | Durable job queue/worker | ARC-08 | — (worker, Postgres `SKIP LOCKED`) | in_progress | — | n/a | processMeeting-guard | 08a: `JobRunner` + step `start`, one active job per meeting (migration 0005); steps transcribe_poll/analyse/embed in 08b–08d |
| REL-02 | Stuck-job recovery | ARC-08, ARC-10 | — (worker), `POST /admin/pipeline/{id}/requeue` | todo | Admin › Pipeline | todo | admin-pipeline | |
| REL-03 | Idempotent retries | ARC-08 | — (worker) | in_progress | — | n/a | processMeeting-guard | 08a: backoff + terminal errors, guarded job writes, restart-safe `start`; later steps 08b–08d |
| PRV-02 | Retention & deletion policy | ARC-08 | — (scheduler) | todo | Meeting detail ("audio deleted") | todo | retention | 409 on reprocess without audio |
| PRV-03 | Encrypt & purge audio after processing | ARC-08 | — (superseded by PRV-02) | n/a | — | n/a | retention | carried by PRV-02 |
| OBS-01 | Error tracking | ARC-04, ARC-11 | — (Sentry in api, body stripped) | todo | — (Sentry in web) | todo | — | |
| OBS-02 | Structured logging | ARC-04 | — (core logging, secret redaction) | todo | — | n/a | — | |
| OBS-03 | Uptime monitoring & alert | ARC-04, ARC-10, ARC-15 | `GET /health` (liveness), `GET /admin/health` (DB + provider checks, 200/503) | todo | Admin › Health | todo | admin-ext | ARC-00 `/health` is only a liveness stub; point the external uptime monitor at v2 at cutover (ARC-15) |
| SEC-01 | Login rate-limiting | ARC-05 | `POST /auth/login` (rate limit) | todo | Sign in | todo | rate-limit | |
| SEC-02 | Email verification | ARC-05 | `POST /auth/register`, `POST /auth/verify-email` *(proposed)* | todo | Verify email | todo | auth-validate | SMTP |
| SEC-03 | RLS review | ARC-02 | — (RLS on `app.user_id` / `app.role`) | todo | — | n/a | folder-shares | integration tests `test_rls*.py` |
| SEC-04 | Secret management | ARC-06 | `GET/POST /admin/keys`, `PATCH/DELETE /admin/keys/{id}` | todo | Admin › Keys | todo | provider-keys | never return ciphertext |
| OPS-01 | CI + automated tests | ARC-00 | — (`ci-api.yml`, `ci-web.yml`) | done | — | done | — | delivered by ARC-00 |
| OPS-04 | Tag-driven release to deployment repo | ARC-15 | `GET /version.json` | todo | — | n/a | app-version | two images in v2 |
| OPS-06 | CI on dev branch | ARC-00 | — (CI triggers include `dev`) | done | — | done | — | delivered by ARC-00 |
| OPS-07 | Release runbook + deploy verify | ARC-15 | `GET /version.json`, `GET /health` | todo | — | n/a | verify-deploy | runbook rewritten for v2 |
| COM-01 | Recording notice/consent | ARC-07, ARC-12 | `POST /activity` (`recording_notice_ack`) | done | Record (notice dialog) | done | recording-notice, activity-log | 12 h ack per tab |
| COM-05 | Sharing & collaboration | ARC-07 | `GET/POST /folders`, `PATCH/DELETE /folders/{id}`, `PUT /folders/reorder`, `GET/POST /folders/{id}/shares`, `PATCH/DELETE /folders/{id}/shares/{granteeId}`, `POST /users/lookup`, `PATCH /meetings/{id}` (`folder_id`), `POST /meetings` (`folder_id`) | in_progress | Meetings list, Manage folders | todo | folder-shares, folder-delete-notice | all routes done except `DELETE /folders/{id}?deleteMeetings=true` (503 until ARC-07 part 2); moving a meeting = `PATCH /meetings/{id}` |
| QUO-01 | Quota schema & balances | ARC-02, ARC-07 | `GET /profile` (`audio_seconds_remaining`, `agent_queries_remaining`) | done | Profile | todo | quota | balance stays in `GET /profile` for parity |
| QUO-02 | Generate enforcement | ARC-08 | — (worker gate before Speechmatics), `POST /admin/pipeline/reconcile-quota` | todo | Meeting detail (`QUOTA_BLOCKED:` error) | todo | quota | |
| QUO-03 | Ask-agent enforcement | ARC-09 | `POST /chat` (pre-check + deduct) | todo | Chat | todo | quota | |
| QUO-04 | Idempotent deduction | ARC-08 | — (worker, same transaction as usage) | in_progress | — | n/a | quota, quota-integration | 08a: reserve + refund keyed per job (`gen:<job_id>:…`, owner 2026-11-02); settle 08b, reconcile 08e |
| QUO-05 | Top-up & balance display | ARC-07, ARC-10 | `GET /profile` (balance), `GET/POST /admin/users/{id}/quota` | in_progress | Profile, Admin › User detail | todo | quota | user balance done (ARC-07); admin top-up is ARC-10 |
| AIP-01 | Provider interface & registry | ARC-08 | — (AI service layer) | todo | — | n/a | ai-registry | |
| AIP-02 | OpenAI adapter | ARC-08 | — (AI service layer) | todo | — | n/a | ai-openai-adapter, ai-gemini-adapter | also the Grok (xAI) adapter, `legacy/lib/grok` |
| AIP-03 | Per-meeting model lock | ARC-08 | — (worker) | todo | Meeting detail (model label) | todo | aip-model-lock, model-label | |
| AIP-04 | Cross-meeting RAG model rule | ARC-09 | `POST /chat` | todo | — | n/a | aip04-chat-model | |
| AIP-05 | Provider-aware key pool | ARC-06 | — (key pool service) | todo | — | n/a | key-pool-base, key-pool-speechmatics, key-healthcheck | |
| AIP-06 | Control plane | ARC-07, ARC-10 | `GET/PATCH /admin/generation-config`, `GET/PATCH /profile/preferences` | in_progress | Admin › Config, Profile | todo | aip-control-plane | `/profile/preferences` done (ARC-07); admin config is ARC-10 |

---

## (b) Legacy route handlers → v2 endpoints (55 + `version.json`)

Legacy path = `legacy/app/api/<path>/route.ts` (and `legacy/app/version.json/route.ts`).

| Legacy route | Methods | v2 endpoint | ARC | Status | Note |
|---|---|---|---|---|---|
| activity | POST | `POST /activity` | ARC-07 | done | client events only, own user, rate-limited |
| admin/activity | GET | `GET /admin/activity` | ARC-10 | todo | |
| admin/ai-usage | GET | `GET /admin/ai-usage` | ARC-10 | todo | |
| admin/audit-logs | GET | `GET /admin/audit-logs` | ARC-10 | todo | |
| admin/config | GET | `GET /admin/config` | ARC-10 | todo | |
| admin/config/[key] | PATCH | `PATCH /admin/config/{key}` | ARC-10 | todo | invalidates config cache |
| admin/features | GET, POST | `GET /admin/features`, `POST /admin/features` | ARC-10 | todo | |
| admin/features/[id] | GET, PATCH | `GET /admin/features/{id}`, `PATCH /admin/features/{id}` | ARC-10 | todo | id = UUID or key |
| admin/generation-config | GET, PATCH | `GET /admin/generation-config`, `PATCH /admin/generation-config` | ARC-10 | todo | |
| admin/health | GET | `GET /admin/health` | ARC-10 | todo | |
| admin/keys | GET, POST | `GET /admin/keys`, `POST /admin/keys` | ARC-06, ARC-10 | todo | |
| admin/keys/[id] | PATCH, DELETE | `PATCH /admin/keys/{id}`, `DELETE /admin/keys/{id}` | ARC-06, ARC-10 | todo | last-active-key guard |
| admin/keys/healthcheck | GET, POST | `GET /admin/keys/healthcheck`, `POST /admin/keys/healthcheck` | ARC-06, ARC-10 | todo | |
| admin/pipeline/[id]/requeue | POST | `POST /admin/pipeline/{id}/requeue` | ARC-10 | todo | 409 without audio |
| admin/pipeline/jobs | GET | `GET /admin/pipeline/jobs` | ARC-10 | todo | metadata only |
| admin/pipeline/overview | GET | `GET /admin/pipeline/overview` | ARC-10 | todo | |
| admin/pipeline/reconcile-quota | POST | `POST /admin/pipeline/reconcile-quota` | ARC-10 | todo | idempotent |
| admin/storage | GET, POST | `GET /admin/storage`, `POST /admin/storage` | ARC-06, ARC-10 | todo | secret write-only |
| admin/storage/[id] | PATCH, DELETE | `PATCH /admin/storage/{id}`, `DELETE /admin/storage/{id}` | ARC-06, ARC-10 | todo | |
| admin/storage/cleanup | POST | `POST /admin/storage/cleanup` | ARC-10 | todo | v1 also deletes from the Supabase bucket; v2 R2 only |
| admin/storage/orphans | GET | `GET /admin/storage/orphans` | ARC-10 | todo | v1 lists the Supabase bucket; v2 lists R2 only |
| admin/usage | GET | `GET /admin/usage` | ARC-10 | todo | v1 reads Supabase Storage sizes; v2 from R2 |
| admin/users | GET | `GET /admin/users` | ARC-10 | todo | v1 uses Supabase Auth Admin API; v2 reads `users` |
| admin/users/[id] | GET, DELETE | `GET /admin/users/{id}`, `DELETE /admin/users/{id}` | ARC-10 | todo | delete R2 audio first |
| admin/users/[id]/quota | GET, POST | `GET /admin/users/{id}/quota`, `POST /admin/users/{id}/quota` | ARC-10 | todo | |
| admin/users/[id]/reset-password | POST | `POST /admin/users/{id}/reset-password` | ARC-05, ARC-10 | todo | v2 sends the reset email via SMTP; the link opens the ARC-05 Reset password screen (`POST /auth/reset-password`) |
| admin/users/[id]/role | PATCH | `PATCH /admin/users/{id}/role` | ARC-10 | todo | |
| admin/users/[id]/status | PATCH | `PATCH /admin/users/{id}/status` | ARC-10 | todo | v2: `disabled_at` + revoke refresh tokens |
| admin/users/bulk | POST | `POST /admin/users/bulk` | ARC-10 | todo | v2 also applies the last-admin guard (defense in depth; v1 relies on `excludeSelf`) |
| audio-url/[id] | GET | `GET /meetings/{id}/audio-url` | ARC-07 | done | path moves under `/meetings`; returns a 15-min `/media` link (Drive, ARC-17) + `hackAudioRender` |
| auth/login | POST | `POST /auth/login` | ARC-05 | todo | |
| auth/logout | POST | `POST /auth/logout` | ARC-05 | todo | revokes refresh token |
| auth/register | POST | `POST /auth/register` | ARC-05 | todo | |
| calendar-suggestions/[id] | PATCH | `PATCH /calendar-suggestions/{id}` | ARC-07 | done | |
| calendar-suggestions/[id]/ics | GET | `GET /calendar-suggestions/{id}/ics` | ARC-07 | done | |
| chat | GET, POST | `GET /chat`, `POST /chat` | ARC-09 | todo | GET = session history per scope |
| folders | GET, POST | `GET /folders`, `POST /folders` | ARC-07 | done | |
| folders/[id] | PATCH, DELETE | `PATCH /folders/{id}`, `DELETE /folders/{id}` | ARC-07 | done | `?deleteMeetings=true` deletes only the caller's meetings (BUG-011), Drive audio first |
| folders/[id]/shares | GET, POST | `GET /folders/{id}/shares`, `POST /folders/{id}/shares` | ARC-07 | done | |
| folders/[id]/shares/[granteeId] | PATCH, DELETE | `PATCH /folders/{id}/shares/{granteeId}`, `DELETE /folders/{id}/shares/{granteeId}` | ARC-07 | done | |
| folders/reorder | PUT | `PUT /folders/reorder` | ARC-07 | done | |
| health | GET | `GET /health` | ARC-04 | done | skeleton in ARC-00; keep dependency-free |
| meetings | POST | `POST /meetings` | ARC-07 | done | creates the meeting + a Drive resumable upload URL; body needs `size` (ARC-07 part 2) |
| meetings/[id] | PATCH, DELETE | `PATCH /meetings/{id}`, `DELETE /meetings/{id}` | ARC-07 | done | PATCH: only the meeting owner moves it (owner decision 2026-11-02); DELETE: Drive audio first, `warning` on failure |
| meetings/[id]/pin | PATCH | `PATCH /meetings/{id}/pin` | ARC-07 | done | |
| meetings/[id]/process | POST | `POST /meetings/{id}/process` | ARC-07, ARC-08 | done | queues the job; the worker is ARC-08. 409 without audio |
| meetings/[id]/regenerate | POST | `POST /meetings/{id}/regenerate` | ARC-07, ARC-08 | todo | route in the ARC-07 meetings router, analysis via ARC-08; owner only, 422 without segments |
| meetings/[id]/uploaded | POST | `POST /meetings/{id}/uploaded` | ARC-07 | done | body `fileId` + `size`; verified with Drive, one job per meeting, 409 unless pending; ffprobe + video extraction move to the ARC-08 worker |
| openapi | GET | `GET /openapi.json` (FastAPI) | ARC-04 | todo | generated, published as CI artifact |
| profile | GET, PATCH | `GET /profile`, `PATCH /profile` | ARC-07 | done | `PATCH` confirms a new avatar (`avatar_key`, `avatar_file_id`, `avatar_size`); `avatar_url` = `/media` link |
| profile/avatar | POST | `POST /profile/avatar` | ARC-07 | done | Drive upload URL (jpeg/png/webp, 2 MB) |
| profile/change-password | POST | `POST /profile/change-password` | ARC-05 | todo | |
| profile/preferences | GET, PATCH | `GET /profile/preferences`, `PATCH /profile/preferences` | ARC-07 | done | |
| todos/[id] | PATCH | `PATCH /todos/{id}` | ARC-07 | done | editor+ |
| users/lookup | POST | `POST /users/lookup` | ARC-07 | done | returns the match (username for an email) but never echoes an email back; do **not** port v1's unpaged `auth.admin.listUsers()` (misses users past page 1) — query `users` directly |
| version.json (non-API route) | GET | `GET /version.json` | ARC-04 | todo | `RICOTDIN_VERSION` → build commit → `"unknown"` |

---

## (c) Browser-only logic to port (ARC-12 unless noted)

| Logic | Legacy source | v2 target | ARC | Status | Tests |
|---|---|---|---|---|---|
| Tab/system audio + mic capture, mixing, audio-only | `legacy/lib/audio/capture.ts`, `legacy/lib/audio/useRecorder.ts` | `app/web/src/lib/audio/` | ARC-12 | done | Record screen (browser check with fake devices) |
| Browser support + missing-system-audio warning | `legacy/lib/audio/support.ts`, `legacy/components/RecorderUI.tsx` | `app/web/src/lib/audio/` + Record screen | ARC-12 | done | support.test |
| Recording notice dialog + 12 h ack (COM-01) | `legacy/lib/consent/recordingNotice.ts`, `legacy/components/RecordingNoticeModal.tsx` | `app/web/src/lib/consent/` + dialog | ARC-12 | done | recording-notice |
| Upload to R2 (presigned PUT, progress, size/type guard) | `legacy/lib/upload/upload.ts`, `useUpload.ts`, `constants.ts`, `legacy/components/FileUploadSection.tsx` | `app/web/src/lib/upload/` | ARC-12 | done (Drive resumable PUT, 500 MB) | — |
| Audio duration fix for live WebM (§9j) | `legacy/lib/audio/durationFix.ts`, `useAudioDurationFix.ts` | `app/web/src/lib/audio/` | ARC-12 | done (`AudioPlayer`) | audio-duration-fix |
| Transcript timestamp → player seek | `legacy/app/(routes)/meetings/[id]/page.tsx` | Meeting detail | ARC-12 | done (`AudioPlayer.seekTo`, `nearestSegment`; placed in ARC-13) | — |
| `.ics` download (fetch + blob with bearer token) | `legacy/app/(routes)/meetings/[id]/page.tsx` | Meeting detail | ARC-12 | done (`downloadIcs`; placed in ARC-13) | — |
| Chat citations → open meeting at timestamp | `legacy/components/ChatPanel.tsx` | Chat panel | ARC-12 | done (`meetingSeekPath` / `parseSeekParam`; placed in ARC-13) | — |
| Transcript export | `legacy/lib/transcript/export.ts` | `app/web/src/lib/transcript/` | ARC-12 | done | transcript-export |
| Folder delete notice + local state after delete | `legacy/lib/folders/deleteNotice.ts` | `app/web/src/lib/folders/` | ARC-13 | todo | folder-delete-notice |
| Client role helpers (canPin / canEdit / canDelete / canManageShares) | `legacy/lib/access/roles.ts` | `app/web/src/lib/access/` | ARC-13 | todo | folder-shares |
| Avatar upload (presigned PUT to R2, then confirm) | `legacy/app/(routes)/profile/page.tsx` | Profile | ARC-12 | done (`uploadAvatar`; Profile screen ARC-13) | avatar-key |
| Model label | `legacy/lib/ai/modelLabel.ts` | `app/web/src/lib/` | ARC-13 | todo | model-label |
| Audio state ("purged") display | `legacy/lib/retention/policy.ts` (`audioState`) | Meeting detail | ARC-13 | todo | retention |
| Admin usage / health / config view helpers | `legacy/lib/admin/usage.ts`, `health.ts`, `config.ts` | `app/web/src/lib/admin/` | ARC-14 | todo | usage-by-user, admin-ext |
| Session handling (getSession / onAuthStateChange / signOut) | `legacy/lib/supabase/auth.ts`, `browser.ts` (`legacy/components/AuthBootstrap.tsx` is a dead stub — not ported) | `app/web/src/lib/auth/` (in-memory access token + silent refresh) | ARC-11 | todo | — |
| Theme | `legacy/lib/theme`, `legacy/hooks/useTheme.ts`, `ThemeProvider.tsx`, `ThemeSwitcher.tsx` | light/dark only (3 legacy themes dropped) | ARC-11 | todo | — |

---

## (d) Direct Supabase access from the browser → v2 endpoints

v1 pages read some tables straight from Supabase (anon key + RLS). v2 has no browser DB access, so each
read needs an endpoint (all *(proposed)*, finalised in ARC-07 / ARC-05).

| v1 browser call | Where | v2 endpoint | ARC | Status |
|---|---|---|---|---|
| `from('meetings')` list (+ folder filter) | `meetings/page.tsx`, `meetings/folder/[id]/page.tsx` | `GET /meetings?folderId=` | ARC-07 | done |
| `from('meetings')` single | `meetings/[id]/page.tsx` | `GET /meetings/{id}` | ARC-07 | done |
| `from('transcript_segments')` | `meetings/[id]/page.tsx` | `GET /meetings/{id}/transcript` | ARC-07 | done |
| `from('todos')` | `meetings/[id]/page.tsx` | `GET /meetings/{id}/todos` | ARC-07 | done |
| `from('calendar_suggestions')` | `meetings/[id]/page.tsx` | `GET /meetings/{id}/calendar-suggestions` | ARC-07 | done |
| `auth.getSession` / `getUser` / `onAuthStateChange` / `setSession` / `signOut` | `(routes)/layout.tsx`, `(auth)/login`, `(auth)/register`, `profile`, `admin/users`, `admin/features`, `meetings`, `meetings/[id]`, `meetings/folder/[id]` (`getUser` → current user id for role helpers), `components/RecorderUI.tsx`, `lib/upload/upload.ts` (token), `lib/supabase/auth.ts` | `POST /auth/login`, `POST /auth/refresh`, `GET /auth/me`, `POST /auth/logout` | ARC-05, ARC-11 | todo |
| Supabase email verification link (`detectSessionInUrl`) | login | `POST /auth/verify-email` (token from the email link) | ARC-05 | todo |

---

## (e) Screens without their own feature row

| Screen | Legacy | v2 endpoints | ARC | FE | Tests |
|---|---|---|---|---|---|
| Admin › Features (feature registry, Phase 15) | `legacy/app/(routes)/admin/features` | `GET/POST /admin/features`, `GET/PATCH /admin/features/{id}` | ARC-10, ARC-14 | todo | features, features-seed-filter |
| Admin › API docs | `legacy/app/(routes)/admin/docs` (reads `/api/openapi`) | `GET /openapi.json` | ARC-04, ARC-14 | todo | — |

---

## Not ported (explicit)

| Item | Reason |
|---|---|
| The 25 `[ ]` features in `tracking.md` | built after v2 (roadmap 2026-10-25) |
| 3 legacy themes (Botanical / Corporate / Playful) | owner decision: one design with light/dark |
| Anonymous sign-in bootstrap (Phase 2) | already disabled since Phase 7 |
| Supabase custom access token hook, `anon` / `authenticated` grants | replaced by own JWT + app DB roles (ARC-02, ARC-05) |
| Legacy Supabase Storage reads (`storage_provider = 'supabase'`) | objects copied to R2 in ARC-03 |
| `legacy/lib/paths/shared.ts` (+ `shared-path` test) | v1-only path helper for the `legacy/` layout (ARC-00) |
