-- Migration 026: per-meeting generation model lock (AIP-03)
-- ---------------------------------------------------------------------------
-- Adds generation_provider + generation_model to meetings so that every meeting
-- remembers which AI provider was used for its analysis.  Re-generation and
-- single-meeting RAG always reuse the locked pair; cross-meeting RAG is unaffected.
--
-- Constraint: both columns must be NULL together or NOT NULL together.
--   (generation_provider IS NULL) = (generation_model IS NULL)
--
-- Backfill: all existing rows → ('gemini', 'gemini-2.5-flash').
--
-- Apply in Supabase dashboard → SQL editor.
-- ---------------------------------------------------------------------------

ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS generation_provider text NULL,
  ADD COLUMN IF NOT EXISTS generation_model    text NULL;

ALTER TABLE meetings
  DROP CONSTRAINT IF EXISTS meetings_model_lock_both_or_neither;

ALTER TABLE meetings
  ADD CONSTRAINT meetings_model_lock_both_or_neither
    CHECK (
      (generation_provider IS NULL) = (generation_model IS NULL)
    );

-- Backfill all existing rows (NULL provider = not yet locked)
UPDATE meetings
   SET generation_provider = 'gemini',
       generation_model    = 'gemini-2.5-flash'
 WHERE generation_provider IS NULL;

-- ---------------------------------------------------------------------------
-- Down (manual rollback):
--   ALTER TABLE meetings
--     DROP CONSTRAINT IF EXISTS meetings_model_lock_both_or_neither;
--   ALTER TABLE meetings
--     DROP COLUMN IF EXISTS generation_provider,
--     DROP COLUMN IF EXISTS generation_model;
-- ---------------------------------------------------------------------------
