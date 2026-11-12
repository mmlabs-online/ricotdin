> Moved from CLAUDE.md §0.6 (ARC-19). Rules here are binding.

### 0.6 v2 core domain API (ARC-07)

- **Routers** `meetings.py`, `content.py` (todos, calendar, `.ics`), `folders.py` (folders, shares,
  reorder, `/users/lookup`), `profile.py`, `activity.py`. `regenerate` is ARC-08. Paths have no
  `/api` prefix (`v2-tracking.md`).
- **Files (part 2, Google Drive, §0.4):** `POST /meetings` creates the pending row
  (`storage_provider='gdrive'`, migration `0004`; title `Nov 2, 2026, 3:05 PM` in
  `Asia/Ho_Chi_Minh`) and a resumable upload URL in one transaction (Drive failure → no row); the
  body must carry `size`. `POST /meetings/{id}/uploaded` (owner, only while `pending`, else 409)
  takes `fileId` + `size`, verifies with `confirm_upload`, queues **one** job (no second while one is
  queued/running); a mismatching file deletes the meeting (v1 `rejectUpload`) → 422. ffprobe and
  video → audio extraction are the ARC-08 worker's. `GET /meetings/{id}/audio-url` (viewer+) →
  `{url: "/media?t=…" (15 min), hackAudioRender}`. Deletes (`DELETE /meetings/{id}`,
  `DELETE /folders/{id}?deleteMeetings=true` = caller's own meetings only, BUG-011) remove the Drive
  file first, each in its own committed step (`delete_files`), then the rows; a storage failure →
  `warning` (meeting delete) and the rows still go. Avatar: `POST /profile/avatar` → upload URL +
  key; `PATCH /profile {avatar_key, avatar_file_id, avatar_size}` confirms the file before saving,
  deletes the old avatar after (only if it is this user's key); `avatar_url` = `/media` link.
  Upload sessions (meetings + avatars): 30 per user per hour (`app.state.upload_limiter`); at most
  20 `pending` meetings per user (429). `/uploaded`: a mapped key + another file id → 409 (the
  meeting is never deleted); a missing file → 422 and the meeting stays (v1); only a rejected file
  that was this meeting's own session upload deletes the meeting. Deletes run a second Drive pass
  after the row delete (an upload confirmed in between). Known, accepted for now: Drive HTTP calls
  run inside the service transaction (holds a connection and the row lock, ≤ ~2 min with retries);
  the avatar map is committed before the profile UPDATE (a failed UPDATE leaves an unreferenced
  2 MB file); deleting a v1 (`r2`/`supabase`) meeting is a Drive no-op until ARC-18 copies files.
- **Editing summary / notes (PRO-06; 6a API + history, 6b web editor + history UI, §0.10):**
  `PATCH /meetings/{id}/content {field: summary|notes, content, baseHash}` (editor+, `done`
  meetings only else 409, `baseHash` = sha-256 hex of the UTF-8 text the edit started from, NULL =
  empty — a different current text → 409 `content_changed`; ≤ 20 000 / 200 000 chars (= the AI
  limits), no NUL / lone surrogates → 422 `invalid_characters`; body ≤ 2.5 MB; the same text
  again writes nothing; 120 per user per hour `app.state.content_limiter`, checked before the
  body is read). History = migration `0007` table `meeting_note_versions` (each row = the text a
  field had from then on, ordered by `created_at` (`clock_timestamp`, writes serialised by the
  meeting row lock) then `id` — no sequence, `public` holds only tables and indexes (tested); a current text the newest row
  does not hold — first edit, or a worker re-process, which writes no version — is kept first as
  an `ai` row; `ai` rows never have an author, also on `regenerate`, which writes the replaced +
  new text; restore writes a `restore` row; the 50 newest per meeting + field are kept).
  `GET /meetings/{id}` adds `summary_edited` / `notes_edited`: the newest version is a person's
  (`user`/`restore`) and equals the current text (`domain.content.edited_by_person`), and
  `summary_ai_links` / `notes_ai_links`: every link target, in any spelling (`https:x`, a leading control character…; the web normalises them with `safeLinkHref`), found in SQL in an `ai` version of
  that field — those links stay text even after a person's edit or a restore of AI text. App role: SELECT under RLS
  (`can_access_meeting(...,'viewer')`); service: SELECT/INSERT/DELETE; worker: none (worker
  re-processing writes no version). `GET /meetings/{id}/content-versions?field=` (no text,
  `editedByUsername` read as service), `GET …/{versionId}`, `POST …/{versionId}/restore
  {baseHash}` (editor+). v2-only table in `V2_ONLY_TABLES`. Pure rules `app/domain/content.py`.
- **Move = meeting owner only** (owner decision 2026-11-02, CWE-269): `PATCH /meetings/{id}` with
  `folder_id` from anyone else → 403 "Only the meeting owner can move it to another folder.";
  editors still rename.
- **Status codes = v1** for owner / folder owner / editor / viewer / stranger (matrix test:
  `tests/test_core_domain_integration.py`). Messages keep v1's text inside `{"error": {code, message}}`.
  Where v1 crashed (500 on `null` bodies, non-UUID ids, `folder_id: ""`) v2 answers 400/404/422.
  Kept on purpose: stranger → 403 on meeting writes but 404 on reads and on folder PATCH/DELETE;
  share PATCH/DELETE answer 200 for a non-member; reorder always 200.
- **One active job per meeting** (ARC-08, migration 0005): unique index
  `jobs_one_active_per_meeting` on `jobs(meeting_id) WHERE status IN ('queued','running')`;
  `process` and `uploaded` insert with `ON CONFLICT ... DO NOTHING` (a repeat while one is active
  queues nothing; `process` still answers 202). `POST /meetings/{id}/process`: 30 per user per hour
  (`app.state.process_limiter`, 429); 409 "This meeting is still being uploaded." while the meeting
  is `pending` and its file is not mapped yet (`/uploaded` queues the job).
- **Who runs what:** meeting reads (`GET /meetings*`) run as `ricotdin_app` under RLS. Meeting /
  todo / calendar writes run as `ricotdin_service`, with the role decided **in the same transaction**
  by `app/services/access.py` + pure `app/domain/access.py` (same logic as `can_access_meeting`;
  admins get no extra access). Folders, shares and lookup run as service with checks in code (v1 did
  the same; avoids the `folders_select` bug, §0.1). `PATCH /profile` and preferences write as
  `ricotdin_app` (column grant + `profiles_update`), so `role` can never be written.
- **Validation** is pure in `app/domain/rules.py`; `.ics` in `app/domain/ics.py`; the model
  allow-list in `app/domain/models.py` (from `app_settings['generation.allowed_models']`, fallback
  gemini only). Bodies are read with `routers/_common.json_object` (bad JSON / non-object → 400).
- `POST /activity`: 10 per user per minute (in-process, `app.state.activity_limiter`); the insert is
  best effort and `meetingId` is stored only for a meeting the caller can see (else NULL).
- Email → account lookups (`POST /users/lookup`, adding a share): 20 per user per 15 min
  (`app.state.lookup_limiter`): v2 searches every user, v1 only the first page.
- Differences from v1 to know: `PATCH /profile` validates every field before the username-taken
  check (v1 checked taken first). Transcript `confidence` is returned as a number. Playback links live
  15 min (v1 60) because `/media` proxies Drive.
