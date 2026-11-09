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

**Use Cases**
1. Meeting detail transcript shows "Speaker 1", "Speaker 2", etc.
2. User clicks a speaker label → inline edit → types real name.
3. `PATCH /api/meetings/:id/speakers` saves the mapping.
4. Optionally: system learns and auto-applies the mapping across future meetings from the same context.
5. Transcript display replaces generic labels with real names everywhere.

**Frontend**
- Inline speaker label editor in the transcript.
- Speaker legend panel (list of all speakers in this meeting with name fields).
- Real names reflected immediately in transcript display.

**Backend**
- `speaker_mappings` table: `id, meeting_id, speaker_label, display_name, user_id`.
- API to CRUD speaker mappings.
- Transcript view joins speaker_mappings when rendering.
- Depends on: PRP-03 (diarization).

---

### PRO-05 — Library-wide search
**Priority:** Medium | **Status:** ❌ Not started

**User Story**  
As a user, I want keyword + semantic search across all meetings for quick lookup.

**Use Cases**
1. User types a query in a global search bar.
2. System performs both keyword (full-text) and semantic (vector) search across all transcripts.
3. Results show meeting title, matching excerpt, timestamp, relevance score.
4. User clicks a result → navigates to the meeting detail at the relevant timestamp.

**Frontend**
- Global search bar (header or dedicated `/search` page).
- Result cards: meeting title, matched excerpt (highlighted), timestamp chip.

**Backend**
- Full-text search: Postgres `tsvector` on `transcript_segments.text`.
- Semantic search: `match_transcript_chunks` RPC (already exists).
- Result fusion: rank by combined score.
- Depends on: PRP-06 (embeddings).

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
