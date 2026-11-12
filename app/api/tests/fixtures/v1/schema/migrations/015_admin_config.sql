-- Migration 015: Replace provider_keys with generic admin_config table
--
-- admin_config is a generic key-value store for admin-managed configuration.
-- Each row holds one config entry (e.g. one API key). The config_key column
-- identifies the type of config (e.g. 'gemini_api_key', 'speechmatics_api_key').
-- Multiple rows per config_key are supported (e.g. a pool of Gemini API keys).
--
-- Values are AES-256-GCM encrypted. The master key lives only in
-- KEY_ENCRYPTION_SECRET (server env var). See lib/crypto/index.ts.
--
-- SECURITY: value_ciphertext, value_iv, value_auth_tag are NEVER returned to
-- browser clients. Only lib/keys/provider.ts reads these columns via the
-- service-role client.
--
-- Replaces migrations/014_provider_keys.sql (drop that table if it exists).

-- Drop the old dedicated table if migration 014 was applied
DROP TABLE IF EXISTS provider_keys CASCADE;

CREATE TABLE IF NOT EXISTS admin_config (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- Identifies what this config entry is for.
  -- Convention: '<provider>_api_key' (e.g. 'gemini_api_key', 'speechmatics_api_key').
  config_key       text        NOT NULL,

  label            text        NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),

  -- AES-256-GCM encrypted value (all base64). Server-side only.
  value_ciphertext text        NOT NULL,
  value_iv         text        NOT NULL,
  value_auth_tag   text        NOT NULL,

  last4            text        NOT NULL CHECK (char_length(last4) = 4),
  status           text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  disabled_reason  text        NULL,
  last_used_at     timestamptz NULL,
  created_by       uuid        REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS admin_config_config_key_status
  ON admin_config (config_key, status);
CREATE INDEX IF NOT EXISTS admin_config_created_at
  ON admin_config (created_at DESC);

ALTER TABLE admin_config ENABLE ROW LEVEL SECURITY;

-- Admins may read config metadata (but the API always uses the service-role client
-- and returns only the masked shape — never ciphertext).
CREATE POLICY "admin_read_admin_config"
  ON admin_config FOR SELECT
  USING (auth.jwt()->>'user_role' = 'admin');

-- All writes go through the service-role client (bypasses RLS).

-- Auto-bump updated_at
CREATE OR REPLACE FUNCTION update_admin_config_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER admin_config_updated_at
  BEFORE UPDATE ON admin_config
  FOR EACH ROW EXECUTE FUNCTION update_admin_config_updated_at();
