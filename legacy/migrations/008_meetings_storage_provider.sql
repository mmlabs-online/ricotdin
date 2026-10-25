-- Migration 008: add storage_provider column to meetings
-- Tracks which object-storage backend holds the audio file.
--   'supabase' = original Supabase Storage bucket (legacy rows, pre-CST-02)
--   'r2'       = Cloudflare R2 (all new rows after this migration)
--
-- The DEFAULT 'supabase' backfills every existing row automatically, so
-- playback, pipeline-download, and delete all keep working via the legacy
-- Supabase branch in lib/storage/index.ts without any data migration.
--
-- Apply in Supabase dashboard → SQL editor.

ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS storage_provider text NOT NULL DEFAULT 'supabase'
    CONSTRAINT meetings_storage_provider_check
      CHECK (storage_provider IN ('supabase', 'r2'));

COMMENT ON COLUMN meetings.storage_provider IS
  'Object-storage backend for audio_path: "supabase" = legacy Supabase Storage, "r2" = Cloudflare R2 (CST-02+).';
