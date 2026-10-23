# Privacy & Data Module (PRV)

**Module prefix:** PRV  
**Status:** ❌ Not started — all three are production/legal blockers before serving other users  
**Priority:** Blockers for any non-self-hosted deployment

---

## Overview

The Privacy & Data module addresses the legal and ethical obligations around handling real users' meeting recordings. The most urgent issue is that the free Gemini tier allows Google to train on submitted data — this must be resolved before any real user meetings are processed.

---

## Features

### PRV-01 — Enable Gemini billing (no-train tier)
**Status:** ❌ Not started  
**Blocker:** Yes — free tier OK for self-testing ONLY

**User Story**  
As the product owner, I want to enable Gemini billing so Google doesn't train on real users' meeting data.

**Use Cases**
1. Product owner enables billing in Google AI Studio / Google Cloud.
2. `GEMINI_API_KEY` is updated to a key associated with a paid project.
3. All subsequent Gemini calls are made on the paid tier (no training on inputs).
4. Cost monitoring (ADM-05) is activated to track spend.

**Why this matters:**  
On the free tier, inputs (including meeting transcripts and audio) may be used by Google for model training. This is ethically and legally unacceptable for real users' private meeting recordings.

**Frontend**
- No UI change.
- Optionally: a banner in the admin dashboard warning "Free tier active — do not process real user meetings."

**Backend**
- Config-only change: update `GEMINI_API_KEY` environment variable.
- Optionally: add a runtime check at startup that warns if the key appears to be a free-tier key.
- Depends on: PRP-03 (all Gemini calls route through `/lib/gemini`).

---

### PRV-02 — Retention & deletion policy
**Status:** ✅ Done (minimal internal-use slice, 2026-10-21) — audio retention purge; account erasure + `/privacy` deferred to ADM-11 / COM  
**Key files:** `lib/retention/{policy,purge-runner,purgeScheduler}.ts`, `migrations/032_meetings_audio_purged.sql`, `tests/retention.test.ts`, `docs/privacy/retention-policy.md`, `app/api/meetings/[id]/process/route.ts`, `app/api/admin/pipeline/[id]/requeue/route.ts`, `app/(routes)/meetings/[id]/page.tsx`  
**Blocker:** Yes — required for any regulated use

**User Story**  
As a user, I want a clear retention/deletion policy and the ability to erase all traces to control sensitive data.

**Use Cases**
1. Product defines a clear retention policy: e.g., audio is kept for 30 days post-processing, then auto-deleted.
2. Users can request a full account erasure (GDPR "right to be forgotten").
3. Account erasure deletes: all meetings, transcripts, todos, chat history, and the Supabase Auth user.
4. Audio files in Supabase Storage are deleted as part of erasure.
5. A privacy policy page explains the retention rules to users.

**Frontend**
- Account settings page: "Delete my account" button with confirmation.
- Privacy policy page (`/privacy`).
- Optional: per-meeting "Delete audio after processing" toggle.

**Backend**
- `DELETE /api/account` — full erasure: same flow as admin user delete (ADM-02) but self-initiated.
- Automated retention cron: `meetings WHERE created_at < now() - retention_period` → delete audio from Storage (keep DB rows with `audio_path=null` for the user's transcript history, OR delete everything based on policy decision).
- Depends on: MMG-04 (delete meeting including audio).

---

### PRV-03 — Encrypt & purge audio after processing
**Status:** ✅ Done — superseded by PRV-02 (roadmap 2026-10-22): purge delivered there; audio encryption not needed while purge is on  
**Risk reduction feature (not a hard blocker)**

**User Story**  
As the product owner, I want to consider encrypting and purging audio after processing to reduce the risk surface.

**Use Cases**

**Option A — Purge after processing:**
1. Once `processMeeting()` completes successfully, the audio file is deleted from Supabase Storage.
2. `meetings.audio_path` is set to `null`.
3. The audio player on the meeting detail page is disabled (transcript + timestamps remain).

**Option B — Encrypt at rest:**
1. Before uploading to Storage, the client encrypts the audio using a per-user key.
2. The server decrypts before sending to Gemini, then discards the plaintext.
3. The Storage bucket holds only ciphertext.

**Recommendation:** Option A (purge) is simpler and provides the strongest privacy guarantee. The trade-off is losing the audio playback feature.

**Frontend**
- If audio is purged: audio player shows "Audio has been deleted for privacy" instead of playback controls.
- Optional user preference: "Delete audio after processing" toggle in account settings.

**Backend**
- Purge: add a post-processing step in `processMeeting.ts` that calls `storage.remove(audio_path)` and sets `meetings.audio_path = null`.
- Conditional: only purge if the user preference is enabled (default off for MVP to preserve playback UX).
- Depends on: PRP-01, MMG-04.

---

## Dependencies

- **PRV-01 depends on:** PRP-03 (Gemini API calls)
- **PRV-02 depends on:** MMG-04 (deletion logic)
- **PRV-03 depends on:** PRP-01 (audio in storage), PRV-02 (policy decision on retention)
- **ADM-11 depends on:** PRV-02

## Legal Context

| Jurisdiction | Requirement | Which feature addresses it |
|---|---|---|
| EU (GDPR) | Right to erasure | PRV-02 (full account deletion) |
| EU (GDPR) | Data minimization | PRV-03 (purge audio after processing) |
| US (various) | Two-party consent for recording | COM-01 (in-app consent notice) |
| All | Privacy Policy | PRV-02 (privacy page) |
| SaaS B2B | DPA | COM-02 (legal docs) |
