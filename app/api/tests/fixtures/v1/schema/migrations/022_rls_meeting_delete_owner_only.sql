-- Migration 022: Restrict meeting and transcript_segment deletion to owner only
--
-- FINDING-2 (HIGH): meetings_delete policy allowed editor+ grantees to permanently
--   delete meetings they don't own, including the meeting owner's audio file.
--   Restriction: owner or admin only.
--
-- FINDING-3 (MEDIUM): transcript_segments_delete allowed editor+ grantees to delete
--   individual transcript rows directly via the REST API (no UI exposed this, but the
--   policy was inconsistent with transcript_chunks_delete which is owner/admin only).
--   Restriction: aligned to owner or admin only.
--
-- Admin bypass is kept here and removed in migration 025 (FINDING-1).
--
-- Companion change: app/api/meetings/[id]/route.ts DELETE handler updated to
-- enforce owner-only (meeting.user_id === caller.id) at the API route layer.
--
-- Two-sided tests:
--   - Meeting owner calls DELETE /api/meetings/:id → 200 OK
--   - Shared editor calls DELETE /api/meetings/:id for a meeting they don't own → 403
--   - Shared editor REST DELETE on transcript_segments row → denied by RLS

-- meetings_delete: owner or admin (remove editor+ branch)
DROP POLICY IF EXISTS "meetings_delete" ON meetings;
CREATE POLICY "meetings_delete"
  ON meetings FOR DELETE
  USING (
    auth.uid() = user_id
    OR auth.jwt()->>'user_role' = 'admin'
  );

-- transcript_segments_delete: owner or admin (align with transcript_chunks_delete)
DROP POLICY IF EXISTS "transcript_segments_delete" ON transcript_segments;
CREATE POLICY "transcript_segments_delete"
  ON transcript_segments FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR auth.jwt()->>'user_role' = 'admin'
  );
