-- Migration 010: add per-turn average confidence to transcript_segments
-- Records the average word-level confidence (0–1, 2 d.p.) for each speaker turn
-- as returned by Speechmatics. NULL for segments processed before this migration.
ALTER TABLE transcript_segments
  ADD COLUMN IF NOT EXISTS confidence numeric(5,2) NULL;
