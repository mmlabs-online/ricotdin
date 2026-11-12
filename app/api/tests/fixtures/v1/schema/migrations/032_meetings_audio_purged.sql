-- Migration 032: audio retention purge (PRV-02)
--
-- The daily retention job (lib/retention/purgeScheduler.ts) deletes the audio file of
-- `done` meetings older than `app_config.storage.audio_retention_days`, sets
-- `audio_path = NULL` and stamps `audio_purged_at`. Transcript, notes, todos and chat are
-- kept. `audio_purged_at` lets the UI tell "audio deleted by policy" apart from "never had
-- audio", and lets reprocess routes refuse a meeting whose audio is gone.
--
-- Additive and backwards-compatible: the previous image ignores the new column.
-- Retention stays OFF until an admin sets storage.audio_retention_days (default null).

ALTER TABLE public.meetings
  ADD COLUMN IF NOT EXISTS audio_purged_at timestamptz NULL;

-- Purge candidates: finished meetings that still hold audio, oldest first.
CREATE INDEX IF NOT EXISTS meetings_retention_purge_idx
  ON public.meetings (created_at)
  WHERE status = 'done' AND audio_path IS NOT NULL;
