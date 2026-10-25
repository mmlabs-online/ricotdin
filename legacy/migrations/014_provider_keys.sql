-- Migration 014: Provider API key pool (Phase 13 / SEC-04)
--
-- Stores AES-256-GCM encrypted API keys for Gemini, Speechmatics, and future
-- providers. The master key lives ONLY in KEY_ENCRYPTION_SECRET (server env var).
--
-- SECURITY:
-- - key_ciphertext, key_iv, key_auth_tag are NEVER returned to browser clients.
--   Only the server-side key provider (lib/keys/provider.ts) reads these columns.
-- - RLS allows admins to read key *metadata* (via anon client) but the admin API
--   routes always query with the service-role client and return only MaskedProviderKey.
-- - All INSERTs / UPDATEs / DELETEs go through the service-role client (RLS bypassed).

CREATE TABLE IF NOT EXISTS provider_keys (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  provider        text        NOT NULL CHECK (provider IN ('gemini', 'speechmatics')),
  label           text        NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),

  -- AES-256-GCM encrypted key material (all base64). Read by server only.
  key_ciphertext  text        NOT NULL,
  key_iv          text        NOT NULL,
  key_auth_tag    text        NOT NULL,

  last4           text        NOT NULL CHECK (char_length(last4) = 4),
  status          text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  disabled_reason text        NULL,
  last_used_at    timestamptz NULL,
  created_by      uuid        REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS provider_keys_provider_status
  ON provider_keys (provider, status);
CREATE INDEX IF NOT EXISTS provider_keys_created_at
  ON provider_keys (created_at DESC);

ALTER TABLE provider_keys ENABLE ROW LEVEL SECURITY;

-- Admins can SELECT metadata rows (the API never returns sensitive columns).
-- All writes use the service-role client (bypasses RLS entirely).
CREATE POLICY "admin_read_provider_keys"
  ON provider_keys FOR SELECT
  USING (auth.jwt()->>'user_role' = 'admin');

-- Auto-bump updated_at on every mutation.
CREATE OR REPLACE FUNCTION update_provider_keys_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_keys_updated_at
  BEFORE UPDATE ON provider_keys
  FOR EACH ROW EXECUTE FUNCTION update_provider_keys_updated_at();
