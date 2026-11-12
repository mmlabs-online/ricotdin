-- Migration 006: add source column to meetings
-- Tracks whether a meeting was captured in-browser ("recorded") or
-- uploaded from an existing file ("uploaded"). Existing rows default to
-- "recorded". RLS is unchanged — the existing "own meetings" policy covers
-- this column automatically.
--
-- Apply in Supabase dashboard → SQL editor.

ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'recorded'
    CONSTRAINT meetings_source_check CHECK (source IN ('recorded', 'uploaded'));

COMMENT ON COLUMN meetings.source IS
  'How the audio arrived: "recorded" = in-browser capture, "uploaded" = user-provided file.';
