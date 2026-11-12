-- 016_activity_log.sql
--
-- High-volume per-user activity log.
-- Distinct from audit_logs (which records rare, sensitive admin operations).
-- This table records the USER perspective: what they did, when, from where.
-- METADATA ONLY — no meeting content (no summary, transcript, notes, audio).
--
-- Event types (extensible text column):
--   Server-side (reliable):
--     login             — successful sign-in
--     logout            — sign-out (server-confirmed via POST /api/auth/logout)
--     meeting_created   — meeting row + upload URL created
--     processing_done   — pipeline finished successfully
--     processing_failed — pipeline errored out
--     chat_message      — user sent a chat question (RAG)
--     meeting_deleted   — meeting permanently deleted
--
--   Client-side best-effort (via POST /api/activity):
--     record_start      — browser started recording
--     record_stop       — browser stopped recording
--
--   Future — share events (schema ready; instrumentation is a TODO hook):
--     meeting_shared    — meeting shared with another user
--     meeting_unshared  — share revoked
--
-- INTENTIONALLY NOT TRACKED: meeting_viewed — too noisy, low value.
--
-- Retention: this table can grow large. Implement a purge job to delete
-- rows older than 90 days (e.g. a scheduled DELETE via a cron or admin endpoint).
-- See POST /api/admin/activity/purge (TODO — leave endpoint as documented stub).

CREATE TABLE IF NOT EXISTS public.activity_log (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),

  -- The user who performed the action
  user_id        uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Extensible event type string — validate at the application layer
  event_type     text        NOT NULL,

  -- Related meeting (title-only join for display; null for non-meeting events)
  meeting_id     uuid        NULL REFERENCES public.meetings(id) ON DELETE SET NULL,

  -- Target user (future: share events — who the meeting was shared WITH)
  target_user_id uuid        NULL REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Small non-content metadata: status codes, durations, flags, etc.
  -- Never store summary/transcript/notes/audio references here.
  metadata       jsonb       NULL,

  -- Request context (best-effort)
  ip             text        NULL,
  user_agent     text        NULL
);

-- RLS: admins can read; all writes go through the service-role client (bypasses RLS)
ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_read_activity_log"
  ON public.activity_log
  FOR SELECT
  TO authenticated
  USING (auth.jwt()->>'user_role' = 'admin');

-- Indexes for the admin query patterns
CREATE INDEX activity_log_user_created  ON public.activity_log (user_id, created_at DESC);
CREATE INDEX activity_log_event_created ON public.activity_log (event_type, created_at DESC);
CREATE INDEX activity_log_created_at    ON public.activity_log (created_at DESC);
CREATE INDEX activity_log_meeting_id    ON public.activity_log (meeting_id)
  WHERE meeting_id IS NOT NULL;
