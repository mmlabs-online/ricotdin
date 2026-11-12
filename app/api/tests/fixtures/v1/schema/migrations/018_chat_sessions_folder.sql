-- RAG-04: Folder-scoped chat
-- Migration 018: adds folder_id anchor to chat_sessions and updates the
-- match_transcript_chunks RPC to accept a set of meeting IDs (uuid[]).
--
-- Scope derivation after this migration:
--   meeting_id set, folder_id null → single-meeting scope
--   folder_id set, meeting_id null → folder scope
--   both null                      → global scope
--
-- Run in the Supabase SQL editor. Idempotent (IF NOT EXISTS / OR REPLACE).

-- ── 1. chat_sessions: add folder_id nullable FK ───────────────────────────────
ALTER TABLE public.chat_sessions
  ADD COLUMN IF NOT EXISTS folder_id uuid
    REFERENCES public.folders (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS chat_sessions_folder_id_idx
  ON public.chat_sessions (user_id, folder_id)
  WHERE folder_id IS NOT NULL;

-- ── 2. match_transcript_chunks: extend to accept uuid[] ──────────────────────
-- Replaces the single filter_meeting_id uuid parameter with filter_meeting_ids
-- uuid[] so that retrieval can be scoped to an arbitrary set of meetings.
--
-- Callers:
--   Single meeting:  filter_meeting_ids => ARRAY[meeting_id]
--   Global:          filter_meeting_ids => NULL  (no filter; RLS applies)
--   Folder:          filter_meeting_ids => array of accessible meeting IDs
CREATE OR REPLACE FUNCTION public.match_transcript_chunks (
  query_embedding    vector(768),
  match_count        int      DEFAULT 6,
  filter_meeting_ids uuid[]   DEFAULT NULL
)
RETURNS TABLE (
  id         uuid,
  meeting_id uuid,
  content    text,
  start_ms   integer,
  end_ms     integer,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT c.id, c.meeting_id, c.content, c.start_ms, c.end_ms,
         1 - (c.embedding <=> query_embedding) AS similarity
  FROM   transcript_chunks c
  WHERE  filter_meeting_ids IS NULL
     OR  c.meeting_id = ANY(filter_meeting_ids)
  ORDER BY c.embedding <=> query_embedding
  LIMIT  match_count;
$$;
