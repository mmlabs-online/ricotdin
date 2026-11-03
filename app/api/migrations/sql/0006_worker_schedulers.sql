-- ARC-08e: worker schedulers (key health check, retention purge, wallet reconcile, stuck meetings).
--
-- 1. scheduler_runs: one row per periodic task; a worker leases a task with a compare-and-set
--    UPDATE (several worker processes never run the same task at once, and "due" survives
--    restarts). Worker SELECT + UPDATE only; app nothing.
-- 2. quota_reconcile_wallets(run): the worker still cannot read or write quota_ledger. The ledger
--    is the source of truth: a wallet that differs from its ledger sum is SET to that sum, with a
--    zero-delta 'adjustment' ledger row as the audit trail (v1 added the drift to both sides, so
--    the drift never closed and the balance moved again every run: BUG-021).
-- 3. retention_purge_audit(meeting, key): the purge's audit row with a forced system actor; only
--    for a meeting the purge has just emptied (audio_path NULL, audio_purged_at in the last hour).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ricotdin_worker') THEN
    RAISE EXCEPTION 'role ricotdin_worker is missing (migration 0002)';
  END IF;
END $$;

-- 1. scheduler_runs -------------------------------------------------------------------------------
CREATE TABLE public.scheduler_runs (
  task text PRIMARY KEY CHECK (task ~ '^[a-z_]{1,40}$'),
  last_started_at timestamptz NULL,
  last_finished_at timestamptz NULL,
  last_status text NULL CHECK (last_status IS NULL OR last_status IN ('ok', 'error')),
  last_detail text NULL CHECK (last_detail IS NULL OR char_length(last_detail) <= 500),
  lease_owner text NULL CHECK (lease_owner IS NULL OR char_length(lease_owner) <= 200),
  lease_until timestamptz NULL
);
INSERT INTO public.scheduler_runs (task) VALUES
  ('key_health'), ('retention_purge'), ('wallet_reconcile'), ('stuck_meetings');

ALTER TABLE public.scheduler_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_all ON public.scheduler_runs AS PERMISSIVE FOR ALL
  TO ricotdin_service, ricotdin_worker USING (true) WITH CHECK (true);
REVOKE ALL ON public.scheduler_runs FROM PUBLIC, ricotdin_app;
GRANT SELECT ON public.scheduler_runs TO ricotdin_service;  -- admin pipeline view (ARC-10)
GRANT SELECT, UPDATE ON public.scheduler_runs TO ricotdin_worker;

-- 2. wallet reconcile ------------------------------------------------------------------------------
CREATE FUNCTION public.quota_reconcile_wallets(p_run uuid)
 RETURNS TABLE(checked integer, drifted integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  w record;
  v_audio bigint;
  v_queries bigint;
  n_checked integer := 0;
  n_drifted integer := 0;
BEGIN
  IF p_run IS NULL THEN
    RAISE EXCEPTION 'quota_reconcile_wallets: run id required' USING ERRCODE = '22023';
  END IF;
  -- One reconcile at a time (several worker processes).
  PERFORM pg_advisory_xact_lock(hashtext('quota_reconcile_wallets'));
  FOR w IN
    SELECT q.user_id, q.audio_seconds_remaining AS audio, q.agent_queries_remaining AS queries
    FROM public.quota_wallets q ORDER BY q.user_id FOR UPDATE
  LOOP
    -- quota_apply_movement changes the wallet and the ledger in one transaction and waits for
    -- this row lock: no read skew between the two sums.
    SELECT COALESCE(sum(l.delta_audio_seconds), 0), COALESCE(sum(l.delta_agent_queries), 0)
      INTO v_audio, v_queries
    FROM public.quota_ledger l WHERE l.user_id = w.user_id;
    n_checked := n_checked + 1;
    IF v_audio <> w.audio OR v_queries <> w.queries THEN
      n_drifted := n_drifted + 1;
      INSERT INTO public.quota_ledger (user_id, delta_audio_seconds, delta_agent_queries, reason,
                                       dedup_key, metadata)
      VALUES (w.user_id, 0, 0, 'adjustment', 'reconcile:' || w.user_id || ':' || p_run,
              jsonb_build_object('reason', 'wallet_reconcile', 'run_id', p_run,
                                 'wallet_audio_before', w.audio, 'ledger_audio', v_audio,
                                 'wallet_queries_before', w.queries, 'ledger_queries', v_queries))
      ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING;
      UPDATE public.quota_wallets
         SET audio_seconds_remaining = v_audio, agent_queries_remaining = v_queries::integer,
             updated_at = now()
       WHERE user_id = w.user_id;
    END IF;
  END LOOP;
  RETURN QUERY SELECT n_checked, n_drifted;
END;
$function$;

-- 3. retention purge audit --------------------------------------------------------------------------
CREATE FUNCTION public.retention_purge_audit(p_meeting_id uuid, p_audio_key text, p_retention_days integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_created timestamptz;
  v_provider text;
BEGIN
  SELECT m.created_at, m.storage_provider INTO v_created, v_provider
  FROM public.meetings m
  WHERE m.id = p_meeting_id AND m.audio_path IS NULL
    AND m.audio_purged_at > now() - interval '1 hour';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retention_purge_audit: meeting not purged' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.audit_logs (actor_id, actor_email, action, target_type, target_id, metadata)
  VALUES (NULL, 'system:retention', 'meeting.audio_purged', 'meeting', p_meeting_id::text,
          jsonb_build_object('retention_days', p_retention_days, 'created_at', v_created,
                             'storage_provider', v_provider,
                             'audio_key', left(p_audio_key, 121)));
END;
$function$;

REVOKE ALL ON FUNCTION public.quota_reconcile_wallets(uuid),
                       public.retention_purge_audit(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.quota_reconcile_wallets(uuid),
                          public.retention_purge_audit(uuid, text, integer) TO ricotdin_worker;
