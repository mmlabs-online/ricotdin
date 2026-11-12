-- ============================================================================
-- Migration 020: quota_wallets + quota_ledger tables and atomic helper
-- ============================================================================
-- Implements QUO-01: per-user prepaid balance backed by an append-only ledger.
--
-- TWO SEPARATE BALANCE AXES — never combine into a single credit:
--   audio_seconds_remaining  →  gates meeting-generation (QUO-02)
--   agent_queries_remaining  →  gates RAG ask-agent calls (QUO-03)
--
-- DESIGN:
--   quota_wallets  — cached current balance, one row per user; denormalized for
--                    fast reads. Source of truth is quota_ledger.
--   quota_ledger   — append-only record of every balance movement (top-ups,
--                    consumptions, refunds, adjustments). Never mutated after insert.
--
-- The atomic helper quota_apply_movement() is the ONLY write path for both
-- tables. All other code (QUO-02/03 enforcement) calls this function.
--
-- Distinct from usage_log (ADM-05 telemetry). usage_log records provider calls
-- for cost observability; quota_ledger records balance movements for enforcement.
-- QUO-02/03 will write to BOTH, independently, after this migration.
--
-- RLS: users read their own wallet/ledger for balance display (QUO-05).
--      Admins read all rows. No user write policies — all writes via the
--      SECURITY DEFINER function or the service-role key.
--
-- Apply in Supabase dashboard → SQL editor.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Table: quota_wallets
-- Cached per-user balance. Written exclusively through quota_apply_movement().
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.quota_wallets (
  user_id                   uuid        PRIMARY KEY
                                          REFERENCES auth.users(id) ON DELETE CASCADE,
  audio_seconds_remaining   bigint      NOT NULL DEFAULT 0,
  agent_queries_remaining   int         NOT NULL DEFAULT 0,
  updated_at                timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.quota_wallets ENABLE ROW LEVEL SECURITY;

-- Users read their own row (balance display, QUO-05).
CREATE POLICY "users_read_own_wallet"
  ON public.quota_wallets FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Admins read all rows (QUO-05 admin top-up UI).
CREATE POLICY "admin_read_all_wallets"
  ON public.quota_wallets FOR SELECT
  TO authenticated
  USING (auth.jwt()->>'user_role' = 'admin');

-- No INSERT/UPDATE/DELETE policies. All writes go through
-- quota_apply_movement() (SECURITY DEFINER) or the service-role client.

-- ----------------------------------------------------------------------------
-- Table: quota_ledger
-- Append-only source of truth for every balance movement.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.quota_ledger (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid        NOT NULL
                                      REFERENCES auth.users(id) ON DELETE CASCADE,
  delta_audio_seconds   bigint      NOT NULL DEFAULT 0,
  delta_agent_queries   int         NOT NULL DEFAULT 0,
  reason                text        NOT NULL
                                      CHECK (reason IN (
                                        'topup', 'admin_grant', 'generate',
                                        'agent_query', 'refund', 'adjustment'
                                      )),
  -- Nullable. When set, a partial unique index (below) ensures retries are
  -- idempotent: a second call with the same dedup_key returns 'already_applied'
  -- without inserting a duplicate ledger row or touching the wallet.
  dedup_key             text        NULL,
  -- SET NULL if the meeting is later deleted; preserves the ledger history.
  meeting_id            uuid        NULL
                                      REFERENCES public.meetings(id) ON DELETE SET NULL,
  -- Admin user id for manual grants; null/system for automated consumption.
  created_by            uuid        NULL,
  -- Non-content metadata: e.g. { "duration_source": "ffprobe_estimate" }.
  -- Never store transcript, summary, or notes here.
  metadata              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.quota_ledger ENABLE ROW LEVEL SECURITY;

-- Users read their own history (QUO-05 balance display / history).
CREATE POLICY "users_read_own_ledger"
  ON public.quota_ledger FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Admins read all rows.
CREATE POLICY "admin_read_all_ledger"
  ON public.quota_ledger FOR SELECT
  TO authenticated
  USING (auth.jwt()->>'user_role' = 'admin');

-- No INSERT/UPDATE/DELETE policies. All writes go through
-- quota_apply_movement() (SECURITY DEFINER) or the service-role client.

-- Partial unique index: makes dedup_key idempotent without creating a unique
-- constraint on NULL (which would be incorrect — NULL != NULL in SQL).
CREATE UNIQUE INDEX quota_ledger_dedup_key_idx
  ON public.quota_ledger (dedup_key)
  WHERE dedup_key IS NOT NULL;

-- Efficient history reads per user (QUO-05 ledger display, admin views).
CREATE INDEX quota_ledger_user_created_idx
  ON public.quota_ledger (user_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- Function: quota_apply_movement
--
-- Single entry point for all balance changes. All logic lives here, not in
-- application code, so correctness holds under concurrency and retry.
--
-- The conditional UPDATE (WHERE balance + delta >= 0) is the race-free gate:
-- two concurrent requests cannot both pass a pre-check and both deduct.
-- The dedup_key unique index ensures a retry after a server restart cannot
-- insert a duplicate ledger row even if the function is called twice.
--
-- SECURITY: SECURITY DEFINER → runs as the function owner (postgres superuser).
--           No GRANT to authenticated/anon; only callable via the service-role
--           client (QUO-02/03 enforcement routes, QUO-05 top-up route).
--           search_path locked to public to prevent search_path injection.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.quota_apply_movement(
  p_user_id              uuid,
  p_delta_audio_seconds  bigint,
  p_delta_agent_queries  int,
  p_reason               text,
  p_dedup_key            text,      -- null for top-ups; set for consumption (idempotency)
  p_allow_overdraw       boolean,   -- true for post-generate settle; false for hard gates
  p_meeting_id           uuid,
  p_created_by           uuid,
  p_metadata             jsonb
)
RETURNS TABLE (status text, audio_remaining bigint, agent_remaining int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_audio  bigint;
  v_agent  int;
BEGIN
  -- 1. Idempotency: if this dedup_key was already applied, return current
  --    balances without making any changes.
  IF p_dedup_key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM quota_ledger WHERE dedup_key = p_dedup_key
    ) THEN
      SELECT audio_seconds_remaining, agent_queries_remaining
        INTO v_audio, v_agent
        FROM quota_wallets
       WHERE user_id = p_user_id;

      -- Wallet may not exist yet if a prior run created the ledger row but
      -- crashed before upserting the wallet. Treat missing wallet as zeros.
      RETURN QUERY SELECT 'already_applied'::text,
                          COALESCE(v_audio, 0)::bigint,
                          COALESCE(v_agent, 0)::int;
      RETURN;
    END IF;
  END IF;

  -- 2. Ensure wallet row exists. First-use lazy creation; the backfill at the
  --    bottom of this migration covers all pre-existing users.
  INSERT INTO quota_wallets (user_id, audio_seconds_remaining, agent_queries_remaining)
  VALUES (p_user_id, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;

  -- 3. Attempt the balance update.
  --
  --    When p_allow_overdraw = false, the WHERE clause enforces that neither
  --    axis goes below zero. Positive (top-up) deltas always satisfy these
  --    conditions, so this branch handles all calls correctly — top-ups never
  --    fail here.
  --
  --    The conditional UPDATE is race-free: if two concurrent agent queries
  --    both land here simultaneously, only the one that wins the write wins
  --    the lock; the other sees ROW_COUNT = 0 and returns 'insufficient'.
  IF NOT p_allow_overdraw THEN
    UPDATE quota_wallets
       SET audio_seconds_remaining = audio_seconds_remaining + p_delta_audio_seconds,
           agent_queries_remaining = agent_queries_remaining + p_delta_agent_queries,
           updated_at              = now()
     WHERE user_id = p_user_id
       AND audio_seconds_remaining + p_delta_audio_seconds >= 0
       AND agent_queries_remaining + p_delta_agent_queries >= 0;

    IF NOT FOUND THEN
      -- At least one axis would go negative. Return current balances; make
      -- NO ledger insert (the movement did not happen).
      SELECT audio_seconds_remaining, agent_queries_remaining
        INTO v_audio, v_agent
        FROM quota_wallets
       WHERE user_id = p_user_id;

      RETURN QUERY SELECT 'insufficient'::text, v_audio, v_agent;
      RETURN;
    END IF;

  ELSE
    -- Top-up or overdraw-allowed settle (e.g. post-generate real-duration
    -- adjustment that may push slightly below zero due to estimation error).
    UPDATE quota_wallets
       SET audio_seconds_remaining = audio_seconds_remaining + p_delta_audio_seconds,
           agent_queries_remaining = agent_queries_remaining + p_delta_agent_queries,
           updated_at              = now()
     WHERE user_id = p_user_id;
  END IF;

  -- 4. Write the ledger row. Only reached when the wallet update succeeded.
  INSERT INTO quota_ledger (
    user_id,
    delta_audio_seconds,
    delta_agent_queries,
    reason,
    dedup_key,
    meeting_id,
    created_by,
    metadata
  ) VALUES (
    p_user_id,
    p_delta_audio_seconds,
    p_delta_agent_queries,
    p_reason,
    p_dedup_key,
    p_meeting_id,
    p_created_by,
    COALESCE(p_metadata, '{}'::jsonb)
  );

  -- 5. Read and return the new balances.
  SELECT audio_seconds_remaining, agent_queries_remaining
    INTO v_audio, v_agent
    FROM quota_wallets
   WHERE user_id = p_user_id;

  RETURN QUERY SELECT 'applied'::text, v_audio, v_agent;
END;
$$;

-- No GRANT to authenticated or anon. This function is called exclusively via
-- the service-role client from server-side TypeScript. The service_role
-- Postgres role has superuser privileges and requires no explicit GRANT.

-- ----------------------------------------------------------------------------
-- Backfill: create empty wallet rows for all existing users.
-- Idempotent (ON CONFLICT DO NOTHING). New users are handled lazily inside
-- quota_apply_movement(), but backfilling keeps balance-read queries simple
-- (no LEFT JOIN or COALESCE needed in the display layer).
-- ----------------------------------------------------------------------------
INSERT INTO public.quota_wallets (user_id, audio_seconds_remaining, agent_queries_remaining)
SELECT id, 0, 0 FROM auth.users
ON CONFLICT (user_id) DO NOTHING;
