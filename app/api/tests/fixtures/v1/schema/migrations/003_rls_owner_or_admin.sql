-- ============================================================================
-- Migration 003: OWNER-OR-ADMIN RLS policies (Phase 7 auth)
-- ============================================================================
-- Replaces the simple "own meetings" family of policies with OWNER-OR-ADMIN
-- versions. Admins (user_role = 'admin' in JWT) can read/write ALL rows.
-- Normal users still see only their own data.
--
-- The `user_role` claim is injected into the JWT by migration 002 (hook).
-- Apply migrations in order: 001, 002, 003.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- meetings
-- ----------------------------------------------------------------------------
drop policy if exists "own meetings" on meetings;

create policy "owner_or_admin_meetings"
  on meetings for all
  using (
    auth.uid() = user_id
    or auth.jwt()->>'user_role' = 'admin'
  )
  with check (
    auth.uid() = user_id
    or auth.jwt()->>'user_role' = 'admin'
  );


-- ----------------------------------------------------------------------------
-- transcript_segments
-- ----------------------------------------------------------------------------
drop policy if exists "own transcript_segments" on transcript_segments;

create policy "owner_or_admin_transcript_segments"
  on transcript_segments for all
  using (
    exists (
      select 1 from meetings m
      where m.id = meeting_id
        and (m.user_id = auth.uid() or auth.jwt()->>'user_role' = 'admin')
    )
  )
  with check (
    exists (
      select 1 from meetings m
      where m.id = meeting_id
        and (m.user_id = auth.uid() or auth.jwt()->>'user_role' = 'admin')
    )
  );


-- ----------------------------------------------------------------------------
-- transcript_chunks
-- ----------------------------------------------------------------------------
drop policy if exists "own transcript_chunks" on transcript_chunks;

create policy "owner_or_admin_transcript_chunks"
  on transcript_chunks for all
  using (
    exists (
      select 1 from meetings m
      where m.id = meeting_id
        and (m.user_id = auth.uid() or auth.jwt()->>'user_role' = 'admin')
    )
  )
  with check (
    exists (
      select 1 from meetings m
      where m.id = meeting_id
        and (m.user_id = auth.uid() or auth.jwt()->>'user_role' = 'admin')
    )
  );


-- ----------------------------------------------------------------------------
-- todos
-- ----------------------------------------------------------------------------
drop policy if exists "own todos" on todos;

create policy "owner_or_admin_todos"
  on todos for all
  using (
    exists (
      select 1 from meetings m
      where m.id = meeting_id
        and (m.user_id = auth.uid() or auth.jwt()->>'user_role' = 'admin')
    )
  )
  with check (
    exists (
      select 1 from meetings m
      where m.id = meeting_id
        and (m.user_id = auth.uid() or auth.jwt()->>'user_role' = 'admin')
    )
  );


-- ----------------------------------------------------------------------------
-- calendar_suggestions
-- ----------------------------------------------------------------------------
drop policy if exists "own calendar_suggestions" on calendar_suggestions;

create policy "owner_or_admin_calendar_suggestions"
  on calendar_suggestions for all
  using (
    exists (
      select 1 from meetings m
      where m.id = meeting_id
        and (m.user_id = auth.uid() or auth.jwt()->>'user_role' = 'admin')
    )
  )
  with check (
    exists (
      select 1 from meetings m
      where m.id = meeting_id
        and (m.user_id = auth.uid() or auth.jwt()->>'user_role' = 'admin')
    )
  );


-- ----------------------------------------------------------------------------
-- chat_sessions
-- ----------------------------------------------------------------------------
drop policy if exists "own chat_sessions" on chat_sessions;

create policy "owner_or_admin_chat_sessions"
  on chat_sessions for all
  using (
    auth.uid() = user_id
    or auth.jwt()->>'user_role' = 'admin'
  )
  with check (
    auth.uid() = user_id
    or auth.jwt()->>'user_role' = 'admin'
  );


-- ----------------------------------------------------------------------------
-- chat_messages
-- ----------------------------------------------------------------------------
drop policy if exists "own chat_messages" on chat_messages;

create policy "owner_or_admin_chat_messages"
  on chat_messages for all
  using (
    exists (
      select 1 from chat_sessions s
      where s.id = session_id
        and (s.user_id = auth.uid() or auth.jwt()->>'user_role' = 'admin')
    )
  )
  with check (
    exists (
      select 1 from chat_sessions s
      where s.id = session_id
        and (s.user_id = auth.uid() or auth.jwt()->>'user_role' = 'admin')
    )
  );
