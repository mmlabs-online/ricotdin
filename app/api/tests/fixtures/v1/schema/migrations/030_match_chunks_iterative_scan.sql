-- Migration 030: fix RAG retrieval returning too few / zero chunks under RLS.
--
-- ROOT CAUSE
-- transcript_chunks.embedding is indexed with HNSW (idx_chunks_embedding).
-- match_transcript_chunks does a filtered vector search:
--     WHERE filter_meeting_ids IS NULL OR meeting_id = ANY(filter_meeting_ids)
--     ORDER BY embedding <=> query_embedding
--     LIMIT match_count
-- With HNSW, the index first collects ~ef_search globally-nearest vectors ACROSS
-- ALL meetings, and only THEN applies the meeting filter and the RLS SELECT
-- policy as post-filters. As the table grows, a single meeting's handful of
-- chunks rarely appear in that global shortlist, so the filters drop everything
-- and the RPC returns 0 rows — the chat then always replies "I couldn't find
-- relevant information…". (Diagnosed: owner can SELECT all 14 chunks, but the
-- vector RPC returned 2 under the user JWT vs 8 under service role — same query.)
--
-- FIX
-- pgvector >= 0.8.0 supports iterative index scans: the executor keeps pulling
-- batches from the HNSW index until LIMIT rows survive the WHERE/RLS filters
-- (or the index is exhausted). We also raise ef_search for better recall.
-- Both are set with SET LOCAL inside a plpgsql body so they apply only to this
-- function's statement and revert automatically afterwards.
--
-- The iterative_scan GUC is wrapped in a guarded block so this migration still
-- succeeds on a pre-0.8.0 pgvector (ef_search alone still helps materially).
--
-- Idempotent: CREATE OR REPLACE keeps the (vector, int, uuid[]) signature.
-- Not SECURITY DEFINER — RLS on transcript_chunks still scopes results, so
-- global-scope (filter_meeting_ids IS NULL) callers only see their own chunks.

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
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  -- Keep scanning the HNSW index until enough post-filtered rows are found.
  -- Guarded: older pgvector (< 0.8.0) has no such GUC — ignore in that case.
  BEGIN
    PERFORM set_config('hnsw.iterative_scan', 'strict_order', true);
  EXCEPTION WHEN OTHERS THEN
    -- GUC not available on this pgvector version; ef_search below still helps.
    NULL;
  END;

  -- Widen the candidate list (default 40). Cheap at our scale, much better recall.
  PERFORM set_config('hnsw.ef_search', '200', true);

  RETURN QUERY
    SELECT c.id, c.meeting_id, c.content, c.start_ms, c.end_ms,
           1 - (c.embedding <=> query_embedding) AS similarity
    FROM   transcript_chunks c
    WHERE  filter_meeting_ids IS NULL
       OR  c.meeting_id = ANY(filter_meeting_ids)
    ORDER BY c.embedding <=> query_embedding
    LIMIT  match_count;
END;
$$;
