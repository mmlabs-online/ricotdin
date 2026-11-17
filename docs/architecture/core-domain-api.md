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
- **Default folder (PRF-07, migration `0008`):** `profiles.default_folder_id` (FK `folders`,
  `ON DELETE SET NULL`). `GET /profile/preferences` returns `defaultFolderId`; `PATCH` takes
  `defaultFolderId` (UUID or null) independently of `provider`/`model` (a body with one leaves the
  other), after `folder_assignable` as service (owner or editor share, else 404). `POST /meetings`
  applies it only when the body has **no** `folderId` key (`null`/`""` = no folder); a default the
  user can no longer add to gives no folder, not 404 (an explicit id still 404s); the stored id stays
  until the folder is deleted (a re-share brings it back), and the web shows it as "no longer
  available". A folder deleted between the check and the write → 404 (FK). The web Record page sends
  an explicit `folderId` from one select (preselected with the default; locked only while a file is
  being sent) for both the recorder and the file upload; if the preferences cannot be loaded it
  offers "your default folder" and sends no `folderId`. The v1 → v2 copy skips the column
  (`V2_ONLY_COLUMNS`, §0.5).
- **UI language (PRF-06, migration `0009`):** `profiles.locale` (`'en' | 'vi'` or NULL, CHECK
  `profiles_locale_check`). `GET /profile/preferences` returns `locale`; `PATCH` takes `locale`
  (`"en"`, `"vi"` or null, else 422) independently of the model and the folder. The web applies the
  account value once per signed-in user per page load (`i18n/useAccountLocale.ts`, module state, so
  switching between the user and admin shells never re-applies it) over the device's localStorage
  choice; NULL keeps the device/browser language. The header toggle and the Profile select apply at
  once, settle the value for that page load (a failed save keeps the local choice) and save in the
  background, one PATCH after another (the last click wins). Emails stay bilingual. The v1 → v2
  copy skips the column (`V2_ONLY_COLUMNS`).
- **Validation** is pure in `app/domain/rules.py`; `.ics` in `app/domain/ics.py`; the model
  allow-list in `app/domain/models.py` (from `app_settings['generation.allowed_models']`, fallback
  gemini only). Bodies are read with `routers/_common.json_object` (bad JSON / non-object → 400).
- `POST /activity`: 10 per user per minute (in-process, `app.state.activity_limiter`); the insert is
  best effort and `meetingId` is stored only for a meeting the caller can see (else NULL).
- **Own data (PRF-13 / ADM-11, migration `0015` = `deleted_accounts`):** `GET /profile/export`
  → ZIP (`services/account.export_account`, pure layout in `domain/export.py`): `README.txt`,
  `profile.json`, `chats.json`, `activity.json`, `meetings/<date>-<slug>-<id8>/meeting.{md,json}`
  for the meetings the user **owns** (speaker names applied, `startedAt` included); no audio, no
  meetings owned by others, no keys / storage paths / `mmlabs_sub`. Read as `ricotdin_service`
  (the WHERE clauses are the only gate); built off the event loop, at most 2 at a time; 3 / hour
  per user (shared with admin exports); audited (`user.export_self`). `DELETE /profile
  {confirm: username}` → `services/account.delete_account` (shared with the admin delete): disable
  → identity cache dropped → Drive files (owned audio + avatar) → audit + tombstone → rows
  cascade; the username is checked in the first transaction only. The tombstone
  (`deleted_accounts`: sha256 of the mmlabs `sub` + `deleted_at`, service-only) makes the first
  request of that mmlabs account refuse a token issued at or before the delete (401
  `account_deleted`) and create a newer one's account **without** the signup quota grant.
  A stuck delete shows as `user.delete_self_started` without `user.delete_self` (the account is
  disabled): finish it with the admin delete. Admin exports share the 3 / hour bucket with the admin's own
  export (keyed on the admin id). Exported chats are the user's own sessions, including those on
  meetings shared with them.
- **Speaker names (PRO-04, migration `0014` = `meetings.speaker_names jsonb` label → name):**
  `PATCH /meetings/{id}/speakers {names: {label: name|null}}` — owner / editor
  (`meeting_facts(lock=True)`; no role → 404, viewer → 403), written as `ricotdin_service`; 30 / min
  (`content_limiter`), body ≤ 8 KiB. A name is set only for a label the meeting's segments have,
  1–60 chars after collapsing spaces, no invisible characters, no `[]<>`, not another label;
  `null` clears (also a stored label the transcript no longer has). `GET /meetings/{id}` returns
  `speaker_names` (the list does not). `GET /speakers/suggestions`: names in the newest 500 named
  meetings the caller can see (RLS), most used first, ≤ 50. Labels in the segments are never
  rewritten; names are applied on display / export (web), in chat excerpts and in the analysis
  prompt. A new transcription clears the map (the worker may update that one column): the
  diarizer numbers voices afresh. Names copied into summaries / chat answers stay with them.
- **Library search (PRO-05, migration `0013` = function `ricotdin_fold`):** `GET /search?q&folderId`
  (`routers/search.py`, pure parts `domain/search.py`). `q` 2–200 chars, terms of ≥ 2 chars, at
  most 8; 30 searches / user / min. Everything runs as `ricotdin_app`, so RLS keeps segments,
  summaries, notes and chunks to meetings the caller can see; a foreign `folderId` finds nothing.
  Keyword: every term `LIKE` (escaped) on `ricotdin_fold(text)` = Python `fold()` (NFC, the same
  `translate` table for Vietnamese / Latin accents, `lower()`; a test pins the table; outside it
  both sides rely on `lower()`, which matches Python on the UTF-8 locale of our Postgres image),
  folded once per row, at most 5 segments per meeting, 200 segment + 50 meeting candidates, no
  index yet (`pg_trgm` on the IMMUTABLE function when data grows). Semantic: the query embedded
  once (`embed-query`, no quota charge) → `match_transcript_chunks` (similarity ≥ 0.5, top 8),
  limited to 10 / min and 300 / day per user (shared key pool); over the limit or on any failure
  the response has keyword results only and `semanticAvailable: false`. `fuse()`:
  reciprocal-rank fusion (k 60), a chunk boosts every overlapping keyword segment, ties keep
  newest meeting first, ≤ 20 meetings × 5 items. Excerpt ranges are UTF-16 code units (JS).
- **Own activity feed (PRF-09, migration `0012` = index `activity_log_target_created`):**
  `GET /profile/activity?eventType&page&perPage` (20 by default, ≤ 50; ASCII digits only; unknown
  type → 400), newest first, as `ricotdin_service` with the filter in code (`activity_log` is
  admin-only under RLS): rows with `user_id` = caller (with their `ip` / `userAgent`) plus
  `folder_shared` / `folder_unshared` rows whose `target_user_id` = caller (with the actor's
  username, never the actor's IP or user agent); only the event types in `app/domain/activity.py`.
  A meeting title (and id) only while the caller can still see the meeting; a `meeting_deleted`
  row shows the title stored in its metadata (≤ 200 chars; only the owner deletes). Events:
  `folder_shared` (add share: user = owner, target = grantee, metadata `{folder_id, folder_name,
  role}`), `folder_unshared` (remove share, only when a row went: user = actor, target = grantee,
  or the owner when a grantee leaves, `left: true`). Folder names are a snapshot at event time.
  Not recorded: role changes on a share, and the shares a folder delete cascades away.
- Email → account lookups (`POST /users/lookup`, adding a share): 20 per user per 15 min
  (`app.state.lookup_limiter`): v2 searches every user, v1 only the first page.
- Differences from v1 to know: `PATCH /profile` validates every field before the username-taken
  check (v1 checked taken first). Transcript `confidence` is returned as a number. Playback links live
  15 min (v1 60) because `/media` proxies Drive.
