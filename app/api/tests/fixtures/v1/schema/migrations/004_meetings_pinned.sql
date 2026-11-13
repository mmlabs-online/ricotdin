-- ============================================================================
-- Migration 004: Add pinned_at to meetings
-- ============================================================================
-- Adds a nullable timestamptz column to track when a meeting was pinned.
-- null = not pinned. The composite index supports the new list sort:
--   ORDER BY pinned_at DESC NULLS LAST, created_at DESC
--
-- Apply in Supabase dashboard → SQL editor.
-- ============================================================================

ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS pinned_at timestamptz NULL;

-- Index for the new sort: pinned first (most-recently-pinned on top),
-- then unpinned newest-first. user_id prefix keeps scans per-user efficient.
CREATE INDEX IF NOT EXISTS meetings_user_pin_sort
  ON meetings (user_id, pinned_at DESC NULLS LAST, created_at DESC);
