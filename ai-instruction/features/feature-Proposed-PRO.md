# Proposed Module (PRO)

**Module prefix:** PRO  
**Status:** ❌ Not started (Phase B — post-MVP)  
**Priority:** High (PRO-01 to PRO-04), Medium (PRO-05 to PRO-07), Low (PRO-08)

---

## Overview

The Proposed module contains planned enhancements beyond the core MVP. These features increase the product's usefulness and stickiness but are explicitly out of MVP scope. They should not be built without an explicit decision to proceed.

---

## Features

### PRO-01 — Auto summary email
**Priority:** High | **Status:** ❌ Not started

**User Story**  
As a user, I want to automatically receive a summary + action items email after processing so I don't have to open the app.

**Use Cases**
1. Meeting finishes processing (status transitions to `done`).
2. System automatically sends an email to the meeting owner.
3. Email contains: meeting title, summary, list of to-dos with assignees, calendar suggestions.
4. Email is sent once; no re-send on re-queue unless explicitly triggered.

**Frontend**
- User preferences: opt-in/opt-out toggle in account settings.
- Email template: branded HTML with summary, todos list, calendar suggestions.

**Backend**
- Hook in `processMeeting.ts` — after status=done, fire email send.
- Email provider: Resend / SendGrid / Supabase SMTP.
- Template: server-rendered HTML.
- Unsubscribe link in footer.
- Depends on: PRP-04 (summary), PRP-05 (todos).

---

### PRO-02 — Google Calendar sync
**Priority:** High | **Status:** ❌ Not started

**User Story**  
As a user, I want to create Google Calendar events in one tap via OAuth instead of only .ics.

**Use Cases**
1. User connects their Google account via OAuth 2.0 in account settings.
2. On meeting detail page, calendar suggestion shows a **"Add to Google Calendar"** button.
3. Clicking it creates the event directly via the Google Calendar API.
4. User receives confirmation in the UI.

**Frontend**
- OAuth connect button in settings.
- Per-suggestion "Add to Google Calendar" button (enabled when Google account connected).
- Replaces/supplements the `.ics` download button.

**Backend**
- Google OAuth 2.0 flow: store refresh token per user.
- `POST /api/calendar/:id/google-sync` → Google Calendar API event create.
- Depends on: PRP-05, CAL-01. Explicitly out of MVP scope.

---

### PRO-03 — To-do reminders
**Priority:** High | **Status:** ❌ Not started

**User Story**  
As a user, I want reminders when a to-do is due via email/push so I don't forget.

**Use Cases**
1. To-do has a `due_date` set.
2. System sends a reminder email/push notification 24 hours before due.
3. User can snooze or dismiss reminders.

**Frontend**
- Reminder settings per to-do (snooze duration, disable).
- Push notification opt-in (browser notification permission).

**Backend**
- Background job (cron) to check for due to-dos and send reminders.
- Push: Web Push API / FCM.
- Depends on: PRP-05, CAL-03.

---

### PRO-04 — Speaker naming
**Priority:** High | **Status:** ❌ Not started

**User Story**  
As a user, I want to set real speaker names instead of "Speaker 1" and remember them across meetings.

**Context**
Re-specced 2026-11-17 (owner Q&A). Speechmatics labels speakers per recording (S1, S2…), so "Speaker 1" is not the same person across meetings. Chosen: names per meeting, and "remember" = the name field suggests names the user already used (no guessing who is who). Names show in the transcript, exports, chat and the next summary regeneration. Owner + editor can name; viewers see. Rejected: voice identification (biometric, its own ticket), names per meeting only without suggestions.

**Use Cases**
1. In the Transcript tab a "Speakers" panel lists Speaker 1, Speaker 2… with a name field each.
2. Typing a name offers names used before (most used first); saving updates the transcript at once.
3. Exports (TXT/MD/SRT) and chat answers / citations use the names; "Regenerate summary" afterwards uses them too.

**Frontend**
- `SpeakerNames` panel in the Transcript tab (owner/editor: inputs + save; viewer: read only), `<datalist>` suggestions.
- Pure `lib/meetings/speakers.ts`: `speakerLabels(segments)`, `applySpeakerNames(segments, names)`, `speakerNamesPatch(before, after)`. EN + VI.

**Backend**
- Migration `0014_speaker_names`: `meetings.speaker_names jsonb NOT NULL DEFAULT '{}'` (label → name).
- `PATCH /meetings/{id}/speakers {names: {"Speaker 1": "Lan", "Speaker 2": null}}`: owner or editor (`can_access_meeting(…, 'editor')`), executed as `ricotdin_service`; labels must exist in the meeting's segments; names 1–60 chars, no invisible characters (SEC-05); `null` clears; returns the full map.
- `GET /meetings/{id}` includes `speaker_names`.
- `GET /speakers/suggestions`: names in `speaker_names` of meetings the caller can see (RLS), most used first, ≤ 50.
- Chat: retrieved chunk text `[Speaker 1]` → `[Lan]` before the prompt and in citations. Regenerate (API) and analyse (worker) use the names for segment speakers.
- Pure: `app/api/app/domain/speakers.py` → `parse_speaker_patch()`, `apply_names()`, `rank_suggestions()`.

**Acceptance Criteria**
- Given an editor names Speaker 1 "Lan", then everyone who can see the meeting sees "Lan" in the transcript; a viewer's or stranger's PATCH → 403 / 404.
- Given a label not in the meeting, an empty / > 60 char / invisible-character name → 400.
- Given names, then TXT/MD/SRT exports and chat answers / citations show them; a later regenerate sends them to the AI.
- Given suggestions, then only names from meetings the caller can see are returned, most used first.

**Test Plan**
- Pure: `app/api/tests/test_speakers.py`; web `app/web/src/lib/meetings/speakers.test.ts`.
- Integration: `app/api/tests/test_speakers_integration.py` — owner/editor/viewer/stranger, validation, detail includes names, suggestions under RLS, chat chunk rename.

**Structural flags**
- Migration 0014 (one column), 2 new routes; ~15 files.

**Done check**
- api + web commands of §0 green; on production, name a speaker and see it in the transcript, an export and a chat answer.

**Out of scope**
- Voice identification; applying names to other meetings automatically; regenerating existing summaries automatically.

**Key files (expected)**
- `app/api/app/domain/speakers.py`, `app/api/app/routers/meetings.py`, `app/api/app/routers/chat.py`, `app/api/app/worker/analyse.py`, `app/api/migrations/`, `app/web/src/components/meeting/DetailPanels.tsx`, `app/web/src/lib/meetings/speakers.ts`, `app/web/src/lib/transcript/export.ts`, i18n.

---

### PRO-05 — Library-wide search
**Priority:** Medium | **Status:** ✅ Done

**User Story**  
As a user, I want keyword + semantic search across all meetings for quick lookup.

**Context**
Re-specced 2026-11-17 (owner Q&A). Today the Meetings search box filters titles only (in the browser) and Chat answers with AI (one chat question each). Chosen: keyword + semantic search over transcript, summary and notes on a `/search` page, reached from the Meetings search box; no quota charge. Rejected: keyword only (misses "budget" ≈ "cost"), transcript only, a search-only nav entry.

**Use Cases**
1. User types in the Meetings search box → "Search in content" → `/search?q=…`.
2. Sees results grouped by meeting (newest-relevant first), each with an excerpt and the matched words highlighted; a transcript hit shows its timestamp.
3. Clicks a transcript hit → meeting detail at that second; a summary / notes hit → meeting detail.
4. Narrows to one folder.

**Frontend**
- `SearchPage` (`/search`, `q` + `folder` in the URL): search box, folder filter, result groups (meeting title link, items with kind badge, time, highlighted excerpt), loading / empty / error / "semantic unavailable" notes. EN + VI.
- Meetings page: a "Search in content" link next to the title filter, carrying the typed text.
- Pure `lib/search/search.ts`: `highlightParts(text, ranges)`, `resultHref(item)`, `tabFromSearch`, `searchHref`, `validQuery`.

**Backend**
- `GET /search?q=&folderId=` (`q` 2–200 chars after trim, terms of ≥ 2 chars, at most 8; 30 searches / user / min; the semantic part 10 / min and 300 / day, else keyword only): as `ricotdin_app`, so RLS limits everything to meetings the caller can see.
  - Keyword: every term must occur (accent- and case-insensitive) in a transcript segment, the summary or the notes; folded with SQL `ricotdin_fold(text)` = Python `fold()`.
  - Semantic: the query embedded once (`embed-query`, no quota charge) → `match_transcript_chunks` (similarity ≥ 0.5, top 8). An embedding failure keeps the keyword results and returns `semanticAvailable: false`.
  - Fusion (pure): reciprocal-rank fusion of the two lists; a semantic chunk covering a keyword segment of the same meeting merges into it; grouped by meeting, at most 20 meetings × 5 items.
- Migration `0013_search_fold`: `public.ricotdin_fold(text)` (IMMUTABLE, SQL, no SECURITY DEFINER; EXECUTE to `ricotdin_app` only). No extension.

**Acceptance Criteria**
- Given meetings of other users, when the caller searches, then only meetings they own, own the folder of, or have a share on appear.
- Given "ngan sach" (or "NGÂN SÁCH"), then text containing "Ngân sách" matches; a multi-word query needs every word.
- Given a query with no shared words but the same meaning, then semantic results appear; given the embedding fails, then keyword results still come back with `semanticAvailable: false` and the page says so.
- Given a transcript result, then it links to `/meetings/:id?t=<seconds>`; a summary / notes result opens that tab (`?tab=`).
- Given `q` shorter than 2 / longer than 200 chars → 400; more than 30 searches a minute → 429; no valid mmlabs token → 401.

**Test Plan**
- Pure: `app/api/app/domain/search.py` → `fold()`, `parse_search()`, `excerpt()`, `fuse()` → `app/api/tests/test_search.py` (incl. `fold` = the migration's translate table).
- Integration: `app/api/tests/test_search_integration.py` — RLS isolation, accents, all terms, semantic (stand-in embedder), embedding failure, folder filter, 400/429/401, SQL `ricotdin_fold` = Python `fold`.
- Web: `app/web/src/lib/search/search.test.ts`; e2e core flow searches the uploaded meeting.

**Structural flags**
- Migration 0013 (one function), new route `/search`, new page; ~15 files.

**Done check**
- api + web commands of §0 green; on production, a word from a meeting's transcript (typed without accents) finds it on `/search`.

**Out of scope**
- A keyword index (pg_trgm / tsvector) until the data needs it; searching to-dos and chat; date filters.

**Key files (expected)**
- `app/api/app/domain/search.py`, `app/api/app/routers/search.py`, `app/api/migrations/`, `app/web/src/routes/SearchPage.tsx`, `app/web/src/api/search.ts`, `app/web/src/lib/search/search.ts`, `app/web/src/routes/MeetingsPage.tsx`, i18n.

---

### PRO-06 — Edit notes with history
**Priority:** Medium | **Status:** ✅ Done (6a: API, history, Markdown editor, PR #83; 6b: rich-text editor + history UI)

**User Story**  
As a meeting owner or editor, I want to edit the summary and notes in a rich-text editor and get earlier versions back so that the meeting record says what was really decided.

**Context**
The AI summary and notes are read-only today; a wrong decision or a misheard name stays in the record and in exports. Owner decisions 2026-11-09: option C (rich text + version history) over A (Markdown box) and B (A + an "edited" flag); formatting = the current safe set (headings, bold, italic, code, lists) **plus links**; keep the 50 newest versions, owner + editor restore, viewers read the history; one code in two PRs. Owner decisions 2026-11-09 (after 6a): single versions can **not** be deleted (only deleting the meeting removes its history); the editor's username is **shown** to everyone who can read the meeting, viewers included. Folders were done earlier; tags (PRO-09), whole-meeting export (PRO-10) and speaker names (PRO-04) are their own codes.

**Use Cases**
1. An editor fixes a wrong decision in the notes and saves; everyone with access sees the fix.
2. The owner regenerates the notes; the edited version is kept in the history and can be restored.
3. Two editors save at the same time; the second gets a conflict instead of silently overwriting.
4. A viewer opens the history to see who changed what and when, but cannot restore.

**Frontend**
- 6a: "Edit" on the Summary and Notes panels (owner/editor only, `lib/access/roles.ts`) → a Markdown textarea + "Preview" (the existing `components/Markdown.tsx`), Save / Cancel, leave-page guard for unsaved changes. 409 → "changed meanwhile: reload or keep editing" notice.
- 6b: rich-text editor (Tiptap/ProseMirror, MIT) limited to the allowed marks/nodes, Markdown in and out (no HTML, no images); toolbar keyboard-accessible; "History" drawer: list (when, who, AI/user/restore), read-only preview, "Restore" (owner/editor, confirmed).
- Links: `lib/markdown.ts` renders `[text](https://…)` as a link only for `https:` URLs, with the URL's host shown next to the text, `target="_blank" rel="noopener noreferrer nofollow"`; any other scheme stays text. Images are never rendered. Chat answers keep rendering links as text (§0.8). Regenerate's confirm says the current text moves to the history.
- EN + VI strings; regenerate `schema.d.ts`.

**Backend**
- Migration `0007_note_versions`: `meeting_note_versions(id uuid pk, meeting_id → meetings ON DELETE CASCADE, field text CHECK ('summary','notes'), content text NOT NULL, source text CHECK ('ai','user','restore'), edited_by uuid → users ON DELETE SET NULL, created_at timestamptz default now())`, index `(meeting_id, field, created_at DESC)`. RLS: SELECT `TO ricotdin_app` via `can_access_meeting(meeting_id,'viewer')`; writes only as `ricotdin_service`; worker no access. Added to `V2_ONLY_TABLES` (BUG-020) and the grants tests.
- `PATCH /meetings/{id}/content {field, content, baseHash}` (editor+, service role, access in the same transaction like other meeting writes): `baseHash` = sha-256 of the content the client started from; mismatch → 409. The previous content is stored as a version (`source` = `ai` if it was never edited, else `user`), then the new content is written. Content ≤ 20 000 chars (summary) / 100 000 (notes), no NUL / lone surrogates. Meeting must be `done` (409 otherwise). Prunes to the 50 newest versions per meeting + field.
- `GET /meetings/{id}/content-versions?field=` (viewer+, RLS) → newest first, without `content` in the list; `GET …/content-versions/{versionId}` → one version.
- `POST /meetings/{id}/content-versions/{versionId}/restore {baseHash}` (editor+) → same as a save with that content, `source='restore'`.
- `regenerate` (API): stores the current summary + notes as versions before overwriting. Worker re-processing does not write versions (accepted: `/process` runs only on `failed` meetings).

**Acceptance Criteria**
- Given an editor and a `done` meeting, when they save notes with the current `baseHash`, then the notes change and the previous text is one new version; a viewer or stranger gets 403 / 404 (v1 matrix).
- Given two saves with the same `baseHash`, then the second answers 409 and nothing is overwritten.
- Given 50 versions, when a 51st is created, then only the 50 newest remain.
- Given a version, when the owner or an editor restores it, then the field equals that version and the replaced text is a new version; a viewer gets 403.
- Given notes with `[x](https://a.test)`, `[y](javascript:alert(1))` and `![i](https://a.test/p.png)`, then only the first renders as a link (host shown, `rel` set), the other two stay text, and no image request is made; chat answers render no link.
- Given a regenerate, then the summary and notes before it are in the history.

**Test Plan**
- Pure logic first:
  - `app/domain/content.py` → `parse_content_edit()` (field, limits, NUL / surrogates), `content_hash()`, `version_source()`, `versions_to_prune()`. Tests: `app/api/tests/test_content_rules.py`.
  - Web: `lib/markdown.ts` link rule (`safeLinkHref`, host label) with the existing timing tests; `lib/meetings/edit.ts` (dirty state, conflict handling). Tests in `src/lib/markdown.test.ts`, `src/lib/meetings/edit.test.ts`.
- Integration: `app/api/tests/test_content_versions_integration.py` (role matrix, 409, prune, restore, regenerate snapshot, RLS read for a share grantee); `test_worker_grants_integration.py` (worker cannot read the table); migration up/down.
- E2E (6b): edit notes, see the version, restore it.

**Structural flags**
- New migration + table + RLS policy, new route family, new web dependency (Tiptap, 6b), link rendering rule change (security review required). ~25 files over two PRs.

**Done check**
- api + web suites green (incl. integration on CI); manual: edit notes as an editor, regenerate as owner, restore the edited version from the history.

**Out of scope**
- Editing transcript text and speaker names (PRO-04), tags (PRO-09), whole-meeting export (PRO-10).
- Real-time co-editing, comments, diff view between versions.
- Versions for meetings re-processed by the worker.

**Key files (expected)**
- `app/api/migrations/versions/0007_note_versions.py`, `app/api/app/domain/content.py`, `app/api/app/routers/content_versions.py` (or `meetings.py`), `app/api/app/routers/meetings.py` (regenerate), `app/api/scripts/migrate_from_supabase.py` (`V2_ONLY_TABLES`)
- `app/web/src/components/meeting/DetailPanels.tsx`, `app/web/src/components/meeting/ContentEditor.tsx`, `app/web/src/components/meeting/RichTextEditor.tsx`, `app/web/src/lib/editor/richDoc.ts`, `app/web/src/lib/meetings/history.ts`, `app/web/src/components/meeting/VersionHistory.tsx`, `app/web/src/lib/markdown.ts`, `app/web/src/api/meetingDetail.ts`, locales

---

### PRO-07 — Desktop app
**Priority:** Medium | **Status:** ❌ Not started

**User Story**  
As a macOS user, I want a desktop app for stable system-audio capture and auto meeting detection.

**Use Cases**
1. User installs a native desktop app (Tauri-based).
2. App captures system audio natively without browser screen-share dialog.
3. App auto-detects when a meeting starts (Zoom/Meet/Teams process detection).
4. App records in the background without a browser tab.
5. App syncs recorded meetings to the web backend.

**Frontend (Desktop)**
- Tauri app with a minimal native UI.
- Menu bar icon for quick recording controls.
- Settings: audio device selection, auto-detection rules.

**Backend**
- Same backend API; desktop app authenticates via the same auth flow.
- Native audio capture: OS-level audio routing (CoreAudio on macOS).
- This is the highest-value technical upgrade if pursued seriously.

---

### PRO-08 — AI depth
**Priority:** Low | **Status:** ❌ Not started

**User Story**  
As a user, I want more accurate AI, multilingual support, meeting-type note templates, and cross-meeting insights.

**Use Cases**
1. Multilingual: detect meeting language, transcribe natively, optionally translate.
2. Note templates: "Sales call", "1:1", "Engineering standup" — each with a tailored summary structure.
3. Cross-meeting insights: trends, recurring topics, frequently assigned tasks.
4. Higher-accuracy transcription: route long/high-value meetings to Gemini Pro.

**Frontend**
- Language selector per meeting (or auto-detected).
- Template selector before or after processing.
- Insights dashboard (`/insights`).

**Backend**
- `meetings.language` column already exists (filled by PRP-03).
- Template: pass meeting type to the analysis prompt.
- Cross-meeting insights: aggregate queries over transcript data.
- Model routing: config flag to select Flash vs. Pro per meeting.

---

### PRO-09 — Tags
**Priority:** Medium | **Status:** ❌ Not started

**User Story**  
As a user, I want to tag meetings and filter the list by tag so that I can find related meetings across folders.

**Context**
Split from PRO-06 on 2026-11-09 (folders were done earlier). Spec to be written with `/add-feature` before building: tag ownership (per user vs per folder), sharing, limits.

---

### PRO-10 — Meeting export
**Priority:** Medium | **Status:** ❌ Not started

**User Story**  
As a user, I want to export a whole meeting (summary, notes, to-dos, transcript) as Markdown or PDF so that I can share it outside Ricotdin.

**Context**
Split from PRO-06 on 2026-11-09. Transcript-only TXT / MD / SRT export already exists (`app/web/src/lib/transcript/export.ts`). Spec to be written with `/add-feature`: client- vs server-side PDF, CSP, which sections.

---

## Dependencies

All PRO features depend on core MVP features being stable. Suggested build order if pursuing:
1. PRO-04 (speaker naming) — high value, low risk
2. PRO-01 (summary email) — high value, low effort
3. PRO-02 (Google Calendar) — needs OAuth setup
4. PRO-05 (library search) — embeddings already exist
5. PRO-07 (desktop app) — major investment, highest ceiling
