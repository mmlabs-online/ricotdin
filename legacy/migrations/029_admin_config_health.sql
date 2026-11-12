-- Migration 029: API key health-check state on admin_config
--
-- Adds per-key health columns populated by the health-check feature:
--   - a daily in-process scheduler (lib/keys/healthScheduler.ts), and
--   - a manual admin trigger (POST /api/admin/keys/healthcheck).
--
-- The check makes a cheap authenticated probe (e.g. list-models) against each
-- provider using the decrypted key and records the verdict here. The plaintext
-- key never leaves the server; only the verdict + timestamp are stored.
--
-- health_status:
--   'healthy'   — the key authenticated successfully (2xx, or 429 = valid+rate-limited)
--   'unhealthy' — the provider rejected the key (401/403)
--   'unknown'   — inconclusive (network error, 5xx, or provider issue)
--
-- Apply in Supabase dashboard → SQL editor.

ALTER TABLE admin_config
  ADD COLUMN IF NOT EXISTS health_status     text        NULL
    CHECK (health_status IN ('healthy', 'unhealthy', 'unknown')),
  ADD COLUMN IF NOT EXISTS health_checked_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS health_detail     text        NULL;

-- Newest-checked-first lookups for the "latest run" display.
CREATE INDEX IF NOT EXISTS admin_config_health_checked_at
  ON admin_config (health_checked_at DESC NULLS LAST);
