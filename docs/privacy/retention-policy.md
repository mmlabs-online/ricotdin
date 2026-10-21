# Audio retention policy (internal)

**Applies to:** Ricotdin, internal use only. **Owner:** project owner. **Feature:** PRV-02.
**Last reviewed:** 2026-10-21.

## What we keep, and for how long

| Data | Kept | Deleted when |
|---|---|---|
| Meeting **audio** (R2, or the legacy Supabase bucket) | `storage.audio_retention_days` days from the time the meeting was recorded (`meetings.created_at`) | Automatically, by the daily retention job, once the meeting is older than that and its processing is `done` |
| Transcript, summary, notes, to-dos, calendar suggestions, chat | Until the meeting is deleted | The owner deletes the meeting (or an admin deletes the user) |
| Audio of meetings that are `pending` / `processing` / `failed` | Until processing succeeds, or the meeting is deleted | Never purged by age, since the audio is still needed to (re)process it |
| Copies at the AI providers | Gemini Files API staging: about 48h. Speechmatics: per their data-use terms (see PRV-01) | By the provider |

The setting is changed at **`/admin/config` → `storage.audio_retention_days`**:
- a whole number of days from 1 to 3650 turns purging on;
- `null` (the default), or any other value, means **keep audio forever**. A malformed value never triggers deletion.

A change takes effect on the next daily run (within 24h, or about 1 minute after a server restart).

## What a purge does

1. Deletes the audio file from storage.
2. Sets `meetings.audio_path = NULL` and `meetings.audio_purged_at = <time>`.
3. Writes one audit-log row: `action = meeting.audio_purged`, actor `system:retention`, visible at `/admin/audit`.

If deleting the file fails, the meeting is left unchanged and retried on the next run. Each run handles at most 500 meetings, oldest first.

## Consequences for users

- The meeting page shows **"Audio deleted (retention policy)"** instead of the player. Transcript timestamps no longer play audio.
- A meeting whose audio was purged **cannot be reprocessed**. `POST /api/meetings/:id/process` and admin requeue return 409. Regenerating the summary from the transcript still works.
- A purge cannot be undone. Restoring a DB backup (OPS-03) taken before a purge brings back `audio_path` values that point at files that no longer exist: playback then fails and reprocessing errors out before touching the transcript, so no further data is lost.
- The clock is `created_at`, not "processing finished". A meeting that sat `failed` for longer than the retention period and is then reprocessed loses its audio on the next daily run after it reaches `done`.
- Only a meeting's own object (`<user_id>/<meeting_id>.<ext>`) is ever deleted. A row whose `audio_path` points elsewhere is logged and skipped.

## Not covered yet

- Self-service account erasure and a public `/privacy` page (ADM-11 / COM, parked while use is internal only).
- An admin "purge now" button.
