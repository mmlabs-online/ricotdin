-- Track which API key drove each AI request.
-- Nullable: env-var keys have no DB row; historical rows have no key recorded.
-- ON DELETE SET NULL: deleting a key from admin_config preserves log history,
-- just clears the reference.

ALTER TABLE usage_log
  ADD COLUMN IF NOT EXISTS key_id uuid NULL REFERENCES admin_config(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS usage_log_key_id_idx
  ON usage_log(key_id)
  WHERE key_id IS NOT NULL;
