-- Migration 024: Tighten EXECUTE grants on shared functions
--
-- FINDING-5 (MEDIUM): can_access_meeting is a SECURITY DEFINER function granted to
-- both authenticated and anon. Anon callers have no legitimate use for this function;
-- the anon grant is an unnecessary attack surface for a SECURITY DEFINER function.
-- auth.uid() returns NULL for anon callers so it always returns FALSE today, but
-- the principle of least privilege applies.
--
-- FINDING-6 (LOW): match_transcript_chunks has the default PostgreSQL PUBLIC execute
-- grant. It is NOT SECURITY DEFINER so anon callers see empty results via RLS anyway,
-- but restricting to authenticated is defense-in-depth.
--
-- Two-sided tests:
--   - Authenticated viewer calls can_access_meeting on accessible meeting → true ✓
--   - Unauthenticated RPC call to can_access_meeting → permission denied ✓
--   - Authenticated user calls match_transcript_chunks RPC with JWT → returns chunks ✓
--   - Unauthenticated RPC call to match_transcript_chunks → permission denied ✓

-- FINDING-5: remove anon grant from can_access_meeting
REVOKE EXECUTE ON FUNCTION public.can_access_meeting(uuid, text) FROM anon;

-- FINDING-6: restrict match_transcript_chunks from PUBLIC to authenticated only
REVOKE EXECUTE ON FUNCTION public.match_transcript_chunks(vector, int, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.match_transcript_chunks(vector, int, uuid) TO authenticated;
