-- ARC-08e: worker schedulers (key health check, retention purge, wallet reconcile, stuck meetings).
--
-- 1. scheduler_runs: one row per periodic task; a worker leases a task with a compare-and-set
--    UPDATE (several worker processes never run the same task at once, and "due" survives
--    restarts). Worker SELECT + UPDATE only; app nothing.
-- 2. quota_reconcile_wallets(run): the worker still cannot read or write quota_ledger. The ledger
--    is the source of truth: a wallet that differs from its ledger sum is SET to that sum, with a
--    zero-delta 'adjustment' ledger row as the audit trail (v1 added the drift to both sides, so
--    the drift never closed and the balance moved again every run: BUG-021).
-- 3. retention_purge_audit(meeting, key, days): the purge's audit row with a forced system actor;
--    only for a done meeting the purge has just emptied, its own key (no longer mapped), once.
-- 4. legacy_reserve_refund(meeting): v1 meeting-keyed reserve of a failed meeting, refunded once.

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
  lease_until timestamptz NULL,
  -- A lease can never outlive its run by much: a poisoned lease cannot stop a task for good.
  CONSTRAINT scheduler_runs_lease_bounded CHECK (
    lease_until IS NULL
    OR (last_started_at IS NOT NULL AND lease_until <= last_started_at + interval '1 hour'))
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
  v_wallet_audio bigint;
  v_wallet_queries integer;
  n_checked integer;
  n_drifted integer := 0;
BEGIN
  IF p_run IS NULL THEN
    RAISE EXCEPTION 'quota_reconcile_wallets: run id required' USING ERRCODE = '22023';
  END IF;
  -- One run at a time; a second caller returns at once instead of queueing.
  IF NOT pg_try_advisory_xact_lock(hashtext('quota_reconcile_wallets')) THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;
  SELECT count(*) INTO n_checked FROM public.quota_wallets;
  -- Find candidates without locks, then lock and re-check only those (a wallet another
  -- transaction holds is skipped and checked by the next run): wallets are never all locked.
  FOR w IN
    SELECT q.user_id
    FROM public.quota_wallets q
    LEFT JOIN (SELECT l.user_id, sum(l.delta_audio_seconds) AS a, sum(l.delta_agent_queries) AS n
               FROM public.quota_ledger l GROUP BY l.user_id) s ON s.user_id = q.user_id
    WHERE q.audio_seconds_remaining <> COALESCE(s.a, 0)
       OR q.agent_queries_remaining <> COALESCE(s.n, 0)
    ORDER BY q.user_id
  LOOP
    SELECT q.audio_seconds_remaining, q.agent_queries_remaining
      INTO v_wallet_audio, v_wallet_queries
    FROM public.quota_wallets q WHERE q.user_id = w.user_id FOR UPDATE SKIP LOCKED;
    CONTINUE WHEN NOT FOUND;
    -- quota_apply_movement changes the wallet and the ledger in one transaction and waits for
    -- this row lock: the sums below are consistent with the wallet just read.
    SELECT COALESCE(sum(l.delta_audio_seconds), 0), COALESCE(sum(l.delta_agent_queries), 0)
      INTO v_audio, v_queries
    FROM public.quota_ledger l WHERE l.user_id = w.user_id;
    CONTINUE WHEN v_audio = v_wallet_audio AND v_queries = v_wallet_queries;
    n_drifted := n_drifted + 1;
    INSERT INTO public.quota_ledger (user_id, delta_audio_seconds, delta_agent_queries, reason,
                                     dedup_key, metadata)
    VALUES (w.user_id, 0, 0, 'adjustment', 'reconcile:' || w.user_id || ':' || p_run,
            jsonb_build_object('reason', 'wallet_reconcile', 'run_id', p_run,
                               'wallet_audio_before', v_wallet_audio, 'ledger_audio', v_audio,
                               'wallet_queries_before', v_wallet_queries,
                               'ledger_queries', v_queries))
    ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING;
    UPDATE public.quota_wallets
       SET audio_seconds_remaining = v_audio, agent_queries_remaining = v_queries::integer,
           updated_at = now()
     WHERE user_id = w.user_id;
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
  v_user uuid;
  v_created timestamptz;
  v_provider text;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days NOT BETWEEN 1 AND 3650 THEN
    RAISE EXCEPTION 'retention_purge_audit: retention days out of range' USING ERRCODE = '22023';
  END IF;
  -- Only a done meeting the purge has just emptied, its own key (no longer stored), once.
  SELECT m.user_id, m.created_at, m.storage_provider INTO v_user, v_created, v_provider
  FROM public.meetings m
  WHERE m.id = p_meeting_id AND m.status = 'done' AND m.audio_path IS NULL
    AND m.audio_purged_at > now() - interval '1 hour';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retention_purge_audit: meeting not purged' USING ERRCODE = '22023';
  END IF;
  IF p_audio_key IS NULL
     OR p_audio_key !~ ('^' || v_user || '/' || p_meeting_id || '(\.[A-Za-z0-9]{1,10})?$')
     OR EXISTS (SELECT 1 FROM public.storage_objects o WHERE o.key = p_audio_key) THEN
    RAISE EXCEPTION 'retention_purge_audit: not this meeting''s purged key' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.audit_logs a WHERE a.action = 'meeting.audio_purged'
             AND a.target_id = p_meeting_id::text) THEN
    RETURN;  -- already recorded: idempotent, never a second row
  END IF;
  INSERT INTO public.audit_logs (actor_id, actor_email, action, target_type, target_id, metadata)
  VALUES (NULL, 'system:retention', 'meeting.audio_purged', 'meeting', p_meeting_id::text,
          jsonb_build_object('retention_days', p_retention_days, 'created_at', v_created,
                             'storage_provider', v_provider, 'audio_key', p_audio_key));
END;
$function$;

-- 4. v1 stuck reservation refund (v1 QUO-02 reconcile): a meeting migrated from v1 mid-run holds a
--    meeting-keyed reserve (gen:<meeting>:reserve) that pipeline_refund (job keys only) never
--    returns. Refund exactly that ledger amount, once, only for a failed meeting with no settle
--    or refund, to the reserve row's user.
CREATE FUNCTION public.legacy_reserve_refund(p_meeting_id uuid)
 RETURNS TABLE(status text, amount bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user uuid;
  v_reserved bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('gen:' || p_meeting_id::text));
  IF NOT EXISTS (SELECT 1 FROM public.meetings m WHERE m.id = p_meeting_id AND m.status = 'failed')
  THEN
    RAISE EXCEPTION 'legacy_reserve_refund: meeting not failed' USING ERRCODE = '22023';
  END IF;
  SELECT l.user_id, -l.delta_audio_seconds INTO v_user, v_reserved
  FROM public.quota_ledger l WHERE l.dedup_key = 'gen:' || p_meeting_id || ':reserve';
  IF NOT FOUND OR v_reserved <= 0 THEN
    RETURN QUERY SELECT 'nothing_reserved'::text, 0::bigint;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.quota_ledger l WHERE l.dedup_key IN
             ('gen:' || p_meeting_id || ':settle', 'gen:' || p_meeting_id || ':refund')) THEN
    RETURN QUERY SELECT 'closed'::text, 0::bigint;
    RETURN;
  END IF;
  RETURN QUERY
    SELECT q.status, v_reserved
    FROM public.quota_apply_movement(
      v_user, v_reserved, 0, 'refund', 'gen:' || p_meeting_id || ':refund', false, p_meeting_id,
      NULL, jsonb_build_object('reason', 'stuck_reclaimed')) q;
END;
$function$;

REVOKE ALL ON FUNCTION public.quota_reconcile_wallets(uuid),
                       public.retention_purge_audit(uuid, text, integer),
                       public.legacy_reserve_refund(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.quota_reconcile_wallets(uuid),
                          public.retention_purge_audit(uuid, text, integer),
                          public.legacy_reserve_refund(uuid) TO ricotdin_worker;
