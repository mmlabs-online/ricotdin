-- Migration 012: Shared folder access (COM-05)
--
-- Adds:
--   1. folder_shares table — per-folder grantee rows (owner is implicit via folders.user_id)
--   2. can_access_meeting(uuid, text) SQL function — single RLS access helper
--   3. Updated RLS policies on all meeting-related tables so shared-folder members
--      can read (viewer+) and write (editor+) meeting data
--
-- Apply in Supabase SQL editor before using the share feature end-to-end.

-- ── 1. folder_shares table ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS folder_shares (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id   uuid        NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        text        NOT NULL CHECK (role IN ('editor', 'viewer')),
  invited_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (folder_id, user_id)
);

CREATE INDEX IF NOT EXISTS folder_shares_folder_id ON folder_shares (folder_id);
CREATE INDEX IF NOT EXISTS folder_shares_user_id   ON folder_shares (user_id);

ALTER TABLE folder_shares ENABLE ROW LEVEL SECURITY;

-- Folder owner can INSERT / UPDATE / DELETE their shares.
CREATE POLICY "folder_owner_manage_shares"
  ON folder_shares FOR ALL
  USING (
    EXISTS (SELECT 1 FROM folders f WHERE f.id = folder_id AND f.user_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM folders f WHERE f.id = folder_id AND f.user_id = auth.uid())
  );

-- Grantees can SELECT their own share rows (to see they were invited and their role).
CREATE POLICY "grantee_read_own_share"
  ON folder_shares FOR SELECT
  USING (user_id = auth.uid());

-- ── 2. Access helper function ──────────────────────────────────────────────
--
-- Used only in RLS policies (not from server-side routes, which call the
-- TypeScript helper in lib/access/index.ts instead to avoid auth.uid()
-- being null under the service-role client).
--
-- Role order: viewer < editor < owner (owner = meeting.user_id or folder.user_id)
-- p_min_role = 'viewer' → returns true for viewer, editor, or owner
-- p_min_role = 'editor' → returns true for editor or owner only

CREATE OR REPLACE FUNCTION public.can_access_meeting(p_meeting_id uuid, p_min_role text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM meetings m
    WHERE m.id = p_meeting_id
      AND (
        -- meeting owner
        m.user_id = auth.uid()
        -- OR owner of the folder the meeting is in
        OR (
          m.folder_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM folders f
            WHERE f.id = m.folder_id AND f.user_id = auth.uid()
          )
        )
        -- OR shared member with sufficient role
        OR (
          m.folder_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM folder_shares fs
            WHERE fs.folder_id = m.folder_id
              AND fs.user_id = auth.uid()
              AND (p_min_role = 'viewer' OR fs.role = 'editor')
          )
        )
      )
  )
$$;

GRANT EXECUTE ON FUNCTION public.can_access_meeting TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_meeting TO anon;

-- ── 3. meetings — replace single FOR ALL policy with per-verb policies ──────

DROP POLICY IF EXISTS "own meetings"              ON meetings;
DROP POLICY IF EXISTS "owner_or_admin_meetings"   ON meetings;

CREATE POLICY "meetings_select"
  ON meetings FOR SELECT
  USING (
    auth.uid() = user_id
    OR auth.jwt()->>'user_role' = 'admin'
    OR public.can_access_meeting(id, 'viewer')
  );

CREATE POLICY "meetings_insert"
  ON meetings FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    OR auth.jwt()->>'user_role' = 'admin'
  );

CREATE POLICY "meetings_update"
  ON meetings FOR UPDATE
  USING (
    auth.uid() = user_id
    OR auth.jwt()->>'user_role' = 'admin'
    OR public.can_access_meeting(id, 'editor')
  )
  WITH CHECK (
    auth.uid() = user_id
    OR auth.jwt()->>'user_role' = 'admin'
    OR public.can_access_meeting(id, 'editor')
  );

CREATE POLICY "meetings_delete"
  ON meetings FOR DELETE
  USING (
    auth.uid() = user_id
    OR auth.jwt()->>'user_role' = 'admin'
    OR public.can_access_meeting(id, 'editor')
  );

-- ── 4. transcript_segments ─────────────────────────────────────────────────

DROP POLICY IF EXISTS "own transcript_segments"              ON transcript_segments;
DROP POLICY IF EXISTS "owner_or_admin_transcript_segments"   ON transcript_segments;

CREATE POLICY "transcript_segments_select"
  ON transcript_segments FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR auth.jwt()->>'user_role' = 'admin'
    OR public.can_access_meeting(meeting_id, 'viewer')
  );

CREATE POLICY "transcript_segments_insert"
  ON transcript_segments FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR auth.jwt()->>'user_role' = 'admin'
  );

CREATE POLICY "transcript_segments_update"
  ON transcript_segments FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR auth.jwt()->>'user_role' = 'admin'
  );

CREATE POLICY "transcript_segments_delete"
  ON transcript_segments FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR auth.jwt()->>'user_role' = 'admin'
    OR public.can_access_meeting(meeting_id, 'editor')
  );

-- ── 5. transcript_chunks ───────────────────────────────────────────────────

DROP POLICY IF EXISTS "own transcript_chunks"              ON transcript_chunks;
DROP POLICY IF EXISTS "owner_or_admin_transcript_chunks"   ON transcript_chunks;

CREATE POLICY "transcript_chunks_select"
  ON transcript_chunks FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR auth.jwt()->>'user_role' = 'admin'
    OR public.can_access_meeting(meeting_id, 'viewer')
  );

CREATE POLICY "transcript_chunks_insert"
  ON transcript_chunks FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR auth.jwt()->>'user_role' = 'admin'
  );

CREATE POLICY "transcript_chunks_update"
  ON transcript_chunks FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR auth.jwt()->>'user_role' = 'admin'
  );

CREATE POLICY "transcript_chunks_delete"
  ON transcript_chunks FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR auth.jwt()->>'user_role' = 'admin'
  );

-- ── 6. todos ───────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "own todos"              ON todos;
DROP POLICY IF EXISTS "owner_or_admin_todos"   ON todos;

CREATE POLICY "todos_select"
  ON todos FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR auth.jwt()->>'user_role' = 'admin'
    OR public.can_access_meeting(meeting_id, 'viewer')
  );

CREATE POLICY "todos_insert"
  ON todos FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR auth.jwt()->>'user_role' = 'admin'
  );

-- Viewers cannot toggle todos; editor+ can.
CREATE POLICY "todos_update"
  ON todos FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR auth.jwt()->>'user_role' = 'admin'
    OR public.can_access_meeting(meeting_id, 'editor')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR auth.jwt()->>'user_role' = 'admin'
    OR public.can_access_meeting(meeting_id, 'editor')
  );

CREATE POLICY "todos_delete"
  ON todos FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR auth.jwt()->>'user_role' = 'admin'
    OR public.can_access_meeting(meeting_id, 'editor')
  );

-- ── 7. calendar_suggestions ────────────────────────────────────────────────

DROP POLICY IF EXISTS "own calendar_suggestions"              ON calendar_suggestions;
DROP POLICY IF EXISTS "owner_or_admin_calendar_suggestions"   ON calendar_suggestions;

CREATE POLICY "calendar_suggestions_select"
  ON calendar_suggestions FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR auth.jwt()->>'user_role' = 'admin'
    OR public.can_access_meeting(meeting_id, 'viewer')
  );

CREATE POLICY "calendar_suggestions_insert"
  ON calendar_suggestions FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR auth.jwt()->>'user_role' = 'admin'
  );

CREATE POLICY "calendar_suggestions_update"
  ON calendar_suggestions FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR auth.jwt()->>'user_role' = 'admin'
    OR public.can_access_meeting(meeting_id, 'editor')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR auth.jwt()->>'user_role' = 'admin'
    OR public.can_access_meeting(meeting_id, 'editor')
  );

CREATE POLICY "calendar_suggestions_delete"
  ON calendar_suggestions FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
    OR auth.jwt()->>'user_role' = 'admin'
    OR public.can_access_meeting(meeting_id, 'editor')
  );

-- ── 8. chat_sessions — sessions are personal; INSERT gate on meeting access ─

DROP POLICY IF EXISTS "own chat_sessions"              ON chat_sessions;
DROP POLICY IF EXISTS "owner_or_admin_chat_sessions"   ON chat_sessions;

-- Users only see their own sessions.
CREATE POLICY "chat_sessions_select"
  ON chat_sessions FOR SELECT
  USING (user_id = auth.uid() OR auth.jwt()->>'user_role' = 'admin');

-- Creating a session for a shared meeting is allowed (user owns their own session row).
CREATE POLICY "chat_sessions_insert"
  ON chat_sessions FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND (
      meeting_id IS NULL
      OR public.can_access_meeting(meeting_id, 'viewer')
    )
  );

CREATE POLICY "chat_sessions_update"
  ON chat_sessions FOR UPDATE
  USING (user_id = auth.uid() OR auth.jwt()->>'user_role' = 'admin');

CREATE POLICY "chat_sessions_delete"
  ON chat_sessions FOR DELETE
  USING (user_id = auth.uid() OR auth.jwt()->>'user_role' = 'admin');

-- ── 9. chat_messages — scoped to the session owner ─────────────────────────

DROP POLICY IF EXISTS "own chat_messages"              ON chat_messages;
DROP POLICY IF EXISTS "owner_or_admin_chat_messages"   ON chat_messages;

CREATE POLICY "chat_messages_select"
  ON chat_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM chat_sessions s
      WHERE s.id = session_id
        AND (s.user_id = auth.uid() OR auth.jwt()->>'user_role' = 'admin')
    )
  );

CREATE POLICY "chat_messages_insert"
  ON chat_messages FOR INSERT
  WITH CHECK (
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
      WHERE s.id = session_id
        AND (s.user_id = auth.uid() OR auth.jwt()->>'user_role' = 'admin')
    )
  );

CREATE POLICY "chat_messages_delete"
  ON chat_messages FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM chat_sessions s
      WHERE s.id = session_id
        AND (s.user_id = auth.uid() OR auth.jwt()->>'user_role' = 'admin')
    )
  );

-- ── 10. folders — split FOR ALL into per-verb so grantees can SELECT ────────

DROP POLICY IF EXISTS "own_folders" ON folders;

-- Grantees can see folders shared with them.
CREATE POLICY "folders_select"
  ON folders FOR SELECT
  USING (
    auth.uid() = user_id
    OR EXISTS (
      SELECT 1 FROM folder_shares fs WHERE fs.folder_id = id AND fs.user_id = auth.uid()
    )
  );

-- Only the owner can create, rename, or delete a folder.
CREATE POLICY "folders_insert"
  ON folders FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "folders_update"
  ON folders FOR UPDATE
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "folders_delete"
  ON folders FOR DELETE
  USING (auth.uid() = user_id);
