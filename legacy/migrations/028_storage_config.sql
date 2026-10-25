-- Migration 028: storage_config — admin-managed object-storage credentials.
--
-- Moves R2 (and future S3-compatible) credentials out of environment variables
-- and into the database so an admin can configure storage from the UI.
--
-- The SECRET access key is AES-256-GCM encrypted (master key = KEY_ENCRYPTION_SECRET,
-- server env only — see lib/crypto/index.ts). The account id / access key id /
-- bucket are stored plaintext (admin-readable; they cannot access data without the
-- secret). The secret is shown only as ••••<last4>.
--
-- SECURITY: secret_ciphertext / secret_iv / secret_auth_tag are NEVER returned to
-- the browser. Only lib/storage/config.ts reads them via the service-role client.
--
-- Env fallback: when no active row exists, lib/storage/config.ts falls back to the
-- R2_* env vars, so existing deployments keep working until a DB config is added.

CREATE TABLE IF NOT EXISTS storage_config (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  provider           text        NOT NULL DEFAULT 'r2' CHECK (provider IN ('r2')),
  label              text        NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),

  -- Non-secret connection fields (admin-readable).
  account_id         text        NOT NULL,
  access_key_id      text        NOT NULL,
  bucket             text        NOT NULL,

  -- AES-256-GCM encrypted secret access key (all base64). Server-side only.
  secret_ciphertext  text        NOT NULL,
  secret_iv          text        NOT NULL,
  secret_auth_tag    text        NOT NULL,
  secret_last4       text        NOT NULL CHECK (char_length(secret_last4) = 4),

  status             text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  disabled_reason    text        NULL,
  last_used_at       timestamptz NULL,
  created_by         uuid        REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS storage_config_provider_status
  ON storage_config (provider, status, created_at DESC);

ALTER TABLE storage_config ENABLE ROW LEVEL SECURITY;

-- Admins may read metadata (the API always uses the service-role client and returns
-- only the masked shape — never ciphertext).
DROP POLICY IF EXISTS "admin_read_storage_config" ON storage_config;
CREATE POLICY "admin_read_storage_config"
  ON storage_config FOR SELECT
  USING (auth.jwt()->>'user_role' = 'admin');

-- All writes go through the service-role client (bypasses RLS).

CREATE OR REPLACE FUNCTION update_storage_config_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS storage_config_updated_at ON storage_config;
CREATE TRIGGER storage_config_updated_at
  BEFORE UPDATE ON storage_config
  FOR EACH ROW EXECUTE FUNCTION update_storage_config_updated_at();
