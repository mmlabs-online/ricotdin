-- Migration 025: Remove admin RLS bypass from content tables
--
-- FINDING-1 (HIGH): Implements ADMIN_CONTENT_ACCESS = manage_accounts_only.
-- Admin users with the anon key + admin JWT previously had full read/write/delete
-- access to all users' meeting content via the Supabase REST API.
--
-- All existing admin pipeline and operational routes use createServerClient()
-- (service-role key), which bypasses RLS entirely — removing the admin JWT bypass
-- from these policies does NOT affect any admin route, UI, or background pipeline.
--
-- Admin RLS bypass is KEPT on management/observability tables:
--   profiles, audit_logs, usage_log, admin_config, app_config, activity_log,
--   features, quota_wallets, quota_ledger, jobs
--
-- Admin RLS bypass is REMOVED from content tables (this migration):
--   meetings, transcript_segments, transcript_chunks, todos, calendar_suggestions,
--   chat_sessions, chat_messages
--
-- Two-sided tests:
--   - Service-role pipeline requeue (processMeeting) → unaffected (bypasses RLS) ✓
--   - Admin REST GET /rest/v1/meetings?select=* with admin JWT → 0 rows for others ✓
--   - Meeting owner browses their own meetings → unaffected ✓
--   - Shared viewer reads meeting content → unaffected (can_access_meeting remains) ✓

-- ── meetings ─────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "meetings_select" ON meetings;
DROP POLICY IF EXISTS "meetings_insert" ON meetings;
DROP POLICY IF EXISTS "meetings_update" ON meetings;
DROP POLICY IF EXISTS "meetings_delete" ON meetings;

CREATE POLICY "meetings_select"
  ON meetings FOR SELECT
  USING (
    auth.uid() = user_id
    OR public.can_access_meeting(id, 'viewer')
  );

CREATE POLICY "meetings_insert"
  ON meetings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "meetings_update"
  ON meetings FOR UPDATE
  USING (
    auth.uid() = user_id
    OR public.can_access_meeting(id, 'editor')
  )
  WITH CHECK (
    auth.uid() = user_id
    OR public.can_access_meeting(id, 'editor')
  );

-- Owner-only delete (editor+ removed in migration 022; admin bypass removed here)
CREATE POLICY "meetings_delete"
  ON meetings FOR DELETE
  USING (auth.uid() = user_id);

-- ── transcript_segments ───────────────────────────────────────────────────────

DROP POLICY IF EXISTS "transcript_segments_select" ON transcript_segments;
DROP POLICY IF EXISTS "transcript_segments_insert" ON transcript_segments;
DROP POLICY IF EXISTS "transcript_segments_update" ON transcript_segments;
DROP POLICY IF EXISTS "transcript_segments_delete" ON transcript_segments;

CREATE POLICY "transcript_segments_select"
  ON transcript_segments FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR public.can_access_meeting(meeting_id, 'viewer')
  );

CREATE POLICY "transcript_segments_insert"
  ON transcript_segments FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
  );

CREATE POLICY "transcript_segments_update"
  ON transcript_segments FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
  );

CREATE POLICY "transcript_segments_delete"
  ON transcript_segments FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
  );

-- ── transcript_chunks ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "transcript_chunks_select" ON transcript_chunks;
DROP POLICY IF EXISTS "transcript_chunks_insert" ON transcript_chunks;
DROP POLICY IF EXISTS "transcript_chunks_update" ON transcript_chunks;
DROP POLICY IF EXISTS "transcript_chunks_delete" ON transcript_chunks;

CREATE POLICY "transcript_chunks_select"
  ON transcript_chunks FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR public.can_access_meeting(meeting_id, 'viewer')
  );

CREATE POLICY "transcript_chunks_insert"
  ON transcript_chunks FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
  );

CREATE POLICY "transcript_chunks_update"
  ON transcript_chunks FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
  );

CREATE POLICY "transcript_chunks_delete"
  ON transcript_chunks FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
  );

-- ── todos ─────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "todos_select" ON todos;
DROP POLICY IF EXISTS "todos_insert" ON todos;
DROP POLICY IF EXISTS "todos_update" ON todos;
DROP POLICY IF EXISTS "todos_delete" ON todos;

CREATE POLICY "todos_select"
  ON todos FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR public.can_access_meeting(meeting_id, 'viewer')
  );

CREATE POLICY "todos_insert"
  ON todos FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
  );

CREATE POLICY "todos_update"
  ON todos FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR public.can_access_meeting(meeting_id, 'editor')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR public.can_access_meeting(meeting_id, 'editor')
  );

CREATE POLICY "todos_delete"
  ON todos FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR public.can_access_meeting(meeting_id, 'editor')
  );

-- ── calendar_suggestions ──────────────────────────────────────────────────────

DROP POLICY IF EXISTS "calendar_suggestions_select" ON calendar_suggestions;
DROP POLICY IF EXISTS "calendar_suggestions_insert" ON calendar_suggestions;
DROP POLICY IF EXISTS "calendar_suggestions_update" ON calendar_suggestions;
DROP POLICY IF EXISTS "calendar_suggestions_delete" ON calendar_suggestions;

CREATE POLICY "calendar_suggestions_select"
  ON calendar_suggestions FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR public.can_access_meeting(meeting_id, 'viewer')
  );

CREATE POLICY "calendar_suggestions_insert"
  ON calendar_suggestions FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
  );

CREATE POLICY "calendar_suggestions_update"
  ON calendar_suggestions FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR public.can_access_meeting(meeting_id, 'editor')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR public.can_access_meeting(meeting_id, 'editor')
  );

CREATE POLICY "calendar_suggestions_delete"
  ON calendar_suggestions FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR public.can_access_meeting(meeting_id, 'editor')
  );

-- ── chat_sessions ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "chat_sessions_select" ON chat_sessions;
DROP POLICY IF EXISTS "chat_sessions_update" ON chat_sessions;
DROP POLICY IF EXISTS "chat_sessions_delete" ON chat_sessions;
-- chat_sessions_insert already had no admin bypass — unchanged

CREATE POLICY "chat_sessions_select"
  ON chat_sessions FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "chat_sessions_update"
  ON chat_sessions FOR UPDATE
  USING (user_id = auth.uid());

CREATE POLICY "chat_sessions_delete"
  ON chat_sessions FOR DELETE
  USING (user_id = auth.uid());

-- ── chat_messages ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "chat_messages_select" ON chat_messages;
DROP POLICY IF EXISTS "chat_messages_update" ON chat_messages;
DROP POLICY IF EXISTS "chat_messages_delete" ON chat_messages;
-- chat_messages_insert already had no admin bypass — unchanged

CREATE POLICY "chat_messages_select"
  ON chat_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM chat_sessions s
      WHERE s.id = session_id AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "chat_messages_update"
  ON chat_messages FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM chat_sessions s
      WHERE s.id = session_id AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "chat_messages_delete"
  ON chat_messages FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM chat_sessions s
      WHERE s.id = session_id AND s.user_id = auth.uid()
    )
  );
