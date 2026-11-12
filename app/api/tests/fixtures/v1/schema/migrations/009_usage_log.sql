-- ============================================================================
-- Migration 009: usage_log table
-- ============================================================================
-- Tracks every AI provider call made by the app: Gemini text generation,
-- Gemini embeddings, Speechmatics STT, and any future provider.
--
-- KEY DESIGN: providers meter in different units.
--   Gemini text      → tokens  (input + output reported separately)
--   Gemini embedding → tokens  (only input; no output token count)
--   Speechmatics     → audio_seconds (duration of the submitted audio)
--
-- The `unit` column names the primary metering unit for each row.
-- The `quantity` column holds the value in that unit — making per-provider
-- aggregation a simple SUM(quantity) WHERE unit = 'tokens'/'audio_seconds'.
-- NEVER aggregate `quantity` across different units — that is meaningless.
--
-- Writes go through the service-role key (bypasses RLS).
-- Reads are restricted to admins only.
--
-- Apply in Supabase dashboard → SQL editor.
-- ============================================================================

CREATE TABLE IF NOT EXISTS usage_log (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),

  -- Which provider / model / operation generated this row.
  -- provider: 'gemini' | 'gemini-embedding' | 'speechmatics' | ...
  -- model:    specific model identifier (e.g. 'gemini-2.5-flash', 'standard')
  -- operation: 'analyze' | 'chat' | 'embed' | 'transcribe' | ...
  provider       text        NOT NULL,
  model          text        NOT NULL,
  operation      text        NOT NULL,

  -- Token counts (nullable; only for token-metered providers like Gemini text).
  input_tokens   int         NULL,
  output_tokens  int         NULL,
  total_tokens   int         NULL,

  -- Duration (nullable; only for STT providers metered by audio length).
  audio_seconds  numeric     NULL,

  -- Primary metering unit + quantity for easy per-unit aggregation.
  -- unit:     'tokens' | 'audio_seconds'
  -- quantity: total_tokens when unit='tokens'; audio_seconds when unit='audio_seconds'
  unit           text        NOT NULL,
  quantity       numeric     NOT NULL,

  -- Outcome of the call.
  -- status:    'ok' | 'rate_limited' | 'error'
  -- http_code: e.g. 200, 429, 500 (null when unavailable)
  status         text        NOT NULL DEFAULT 'ok',
  http_code      int         NULL,

  -- Attribution (metadata only — no meeting content is stored here).
  -- SET NULL if the referenced row is later deleted.
  meeting_id     uuid        NULL REFERENCES meetings(id) ON DELETE SET NULL,
  user_id        uuid        NULL REFERENCES auth.users(id) ON DELETE SET NULL
);

-- RLS: admins read; service-role writes bypass RLS.
ALTER TABLE usage_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_read_usage_log"
  ON usage_log FOR SELECT
  USING (auth.jwt()->>'user_role' = 'admin');

-- Indexes for common admin queries.
CREATE INDEX IF NOT EXISTS usage_log_created_at_idx  ON usage_log (created_at DESC);
CREATE INDEX IF NOT EXISTS usage_log_provider_idx    ON usage_log (provider, model);
CREATE INDEX IF NOT EXISTS usage_log_operation_idx   ON usage_log (operation);
CREATE INDEX IF NOT EXISTS usage_log_meeting_id_idx  ON usage_log (meeting_id) WHERE meeting_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS usage_log_status_idx      ON usage_log (status) WHERE status != 'ok';
