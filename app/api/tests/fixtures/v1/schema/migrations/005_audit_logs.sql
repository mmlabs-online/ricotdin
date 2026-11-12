-- ============================================================================
-- Migration 005: audit_logs table
-- ============================================================================
-- Stores an immutable record of every admin action (role changes, user
-- enable/disable/delete, password-reset triggers, meeting requeues).
--
-- Writes go through the service-role key (bypasses RLS).
-- Reads are restricted to admins only.
--
-- Apply in Supabase dashboard → SQL editor.
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),

  -- Who performed the action. SET NULL if the actor account is later deleted.
  actor_id     uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_email  text        NOT NULL,

  -- What happened.
  -- Namespaced dot-notation: 'user.role_change', 'user.disable', 'user.enable',
  -- 'user.delete', 'user.password_reset', 'meeting.requeue'
  action       text        NOT NULL,

  -- What was acted on.
  target_type  text        NOT NULL,  -- 'user' | 'meeting'
  target_id    text        NOT NULL,  -- UUID as text

  -- Structured context (before/after values, counts, error snippets, …).
  -- Never store transcript content, audio paths, or other PII beyond what is
  -- already in actor_email/target_id.
  metadata     jsonb       NOT NULL DEFAULT '{}',

  -- Optional request context.
  ip_address   text,
  user_agent   text
);

-- Admins can SELECT; nobody can INSERT/UPDATE/DELETE through the anon key.
-- Service-role writes bypass RLS entirely.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_read_audit_logs"
  ON audit_logs FOR SELECT
  USING (auth.jwt()->>'user_role' = 'admin');

-- Efficient lookups: by actor, by target, by action type, by time range.
CREATE INDEX IF NOT EXISTS audit_logs_actor_id_idx     ON audit_logs (actor_id);
CREATE INDEX IF NOT EXISTS audit_logs_target_idx       ON audit_logs (target_type, target_id);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx       ON audit_logs (action);
CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx   ON audit_logs (created_at DESC);
