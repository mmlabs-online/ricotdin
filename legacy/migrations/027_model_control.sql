-- 027_model_control.sql
-- AIP-06: per-user model preference (PRF-08) + admin allow-list + system default (ADM-10).
-- Safe to re-run.

-- ── PRF-08: per-user model preference ────────────────────────────────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS default_provider text NULL,
  ADD COLUMN IF NOT EXISTS default_model    text NULL;

-- Both columns must be set together or both null.
ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_model_pref_both_or_neither;
ALTER TABLE profiles
  ADD CONSTRAINT profiles_model_pref_both_or_neither
    CHECK ((default_provider IS NULL) = (default_model IS NULL));

-- Allow authenticated users to update only these two columns.
-- Server routes validate against the allow-list before accepting any value.
GRANT UPDATE(default_provider, default_model) ON profiles TO authenticated;

-- ── ADM-10: system-wide generation config ────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_settings_admin_select ON app_settings;
CREATE POLICY app_settings_admin_select ON app_settings
  FOR SELECT TO authenticated
  USING (auth.jwt()->>'user_role' = 'admin');

-- Seed defaults.  ON CONFLICT = re-run safe.
INSERT INTO app_settings (key, value) VALUES
  ('generation.system_default',
   '{"provider":"gemini","model":"gemini-2.5-flash"}'::jsonb),
  ('generation.allowed_models',
   '[{"provider":"gemini","model":"gemini-2.5-flash"},{"provider":"openai","model":"gpt-4o"},{"provider":"openai","model":"gpt-4o-mini"}]'::jsonb)
ON CONFLICT (key) DO NOTHING;
