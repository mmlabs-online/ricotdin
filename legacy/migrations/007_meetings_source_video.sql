-- Migration 007: extend meetings.source to accept 'video'
-- Allows uploaded video files whose audio has been server-side extracted.
-- Drops and re-adds the check constraint (no data-loss — additive values only).
--
-- Apply in Supabase dashboard → SQL editor.

ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_source_check;

ALTER TABLE meetings
  ADD CONSTRAINT meetings_source_check
    CHECK (source IN ('recorded', 'uploaded', 'video'));

COMMENT ON COLUMN meetings.source IS
  'How the audio arrived: "recorded" = in-browser capture, "uploaded" = audio file, "video" = video file (audio extracted server-side).';
