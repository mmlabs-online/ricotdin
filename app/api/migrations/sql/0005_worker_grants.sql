-- ARC-08: least privilege for the pipeline worker + one active job per meeting.
--
-- 1. One queued/running job per meeting (ARC-08 acceptance criterion, ARC-07 security review):
--    a partial unique index. Existing duplicates are resolved first: per meeting the newest
--    active job (created_at, then id) stays, the others are marked failed.
-- 2. ricotdin_worker: an explicit per-table allow-list replaces "the service's privileges minus
--    the auth tables" (0002). The worker runs untrusted audio through ffmpeg, so an RCE there
--    must reach as little as possible (ARC-04 security review). What ARC-08 (08a–08e) needs:
--      meetings            SELECT; UPDATE of pipeline columns only (status, error_message,
--                          summary, notes, language, generation_*, duration_seconds,
--                          audio_path + audio_purged_at for the retention purge)
--      jobs                SELECT; UPDATE of the columns the runner writes (claim_next_job is
--                          SECURITY DEFINER; no INSERT/DELETE)
--      transcript_segments, transcript_chunks, todos, calendar_suggestions
--                          SELECT, INSERT, UPDATE, DELETE (pipeline output, reprocess cleanup)
--      storage_objects     SELECT, INSERT, UPDATE, DELETE (0003: download, purge; /media lookup)
--      drive_config        SELECT (0003)
--      admin_config        SELECT; UPDATE of health_status / health_checked_at / health_detail /
--                          last_used_at (key health check)
--      app_config, app_settings, quota_wallets   SELECT
--      profiles            SELECT (id, default_provider, default_model) — model resolution
--      usage_log, activity_log                   INSERT (append-only logs)
--      EXECUTE (explicit)  claim_next_job and the pipeline quota wrappers below. Not the general
--                          quota_apply_movement: the worker can only charge / refund / settle
--                          the owner of a job's meeting, by amounts the ledger fixes.
--    audit_logs is not granted: 08e adds a SECURITY DEFINER function for the retention purge that
--    forces actor_id NULL / actor_email 'system:…'.
--    Everything else is revoked: users / tokens (already), folders, folder_shares, chat_*,
--    features, storage_config (v1 R2 secret), quota_ledger, audit_logs and the explicit grants
--    on other functions. Functions that are PUBLIC-executable since v1 (can_access_meeting,
--    match_transcript_chunks, trigger functions, extensions) stay so.
--    The permissive service_all policy keeps the worker only on the tables it keeps.
-- 3. Pipeline quota wrappers (SECURITY DEFINER, worker only): pipeline_reserve / pipeline_refund /
--    pipeline_settle. The user is always the job's meeting owner (reserve) or the reserve row's
--    user (refund / settle); dedup keys gen:<job_id>:reserve|refund|settle; refund and settle
--    amounts come from the reserve ledger row, never from jobs.payload. All three take a per-job
--    advisory transaction lock first, so a refund and a settle can never both apply; refund needs
--    a failed job, reserve and settle a running one.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ricotdin_worker') THEN
    RAISE EXCEPTION 'role ricotdin_worker is missing (migration 0002)';
  END IF;
END $$;

-- 1. one active job per meeting ---------------------------------------------------------------
UPDATE public.jobs j
SET status = 'failed', last_error = 'duplicate active job (migration 0005)',
    locked_at = NULL, locked_by = NULL
WHERE j.status IN ('queued', 'running')
  AND EXISTS (
    SELECT 1 FROM public.jobs k
    WHERE k.meeting_id = j.meeting_id AND k.status IN ('queued', 'running')
      AND (k.created_at, k.id) > (j.created_at, j.id)
  );
CREATE UNIQUE INDEX jobs_one_active_per_meeting ON public.jobs (meeting_id)
  WHERE status IN ('queued', 'running');

-- 2. worker allow-list ---------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ricotdin_worker;

GRANT SELECT ON public.meetings TO ricotdin_worker;
GRANT UPDATE (status, error_message, summary, notes, language, generation_provider,
              generation_model, duration_seconds, audio_path, audio_purged_at)
  ON public.meetings TO ricotdin_worker;
GRANT SELECT ON public.jobs TO ricotdin_worker;
GRANT UPDATE (status, step, attempts, last_error, run_after, payload, locked_at, locked_by)
  ON public.jobs TO ricotdin_worker;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.transcript_segments, public.transcript_chunks, public.todos,
     public.calendar_suggestions, public.storage_objects
  TO ricotdin_worker;
GRANT SELECT ON public.drive_config TO ricotdin_worker;
GRANT SELECT ON public.admin_config TO ricotdin_worker;
GRANT UPDATE (health_status, health_checked_at, health_detail, last_used_at)
  ON public.admin_config TO ricotdin_worker;
GRANT SELECT ON public.app_config, public.app_settings, public.quota_wallets TO ricotdin_worker;
GRANT SELECT (id, default_provider, default_model) ON public.profiles TO ricotdin_worker;
GRANT INSERT ON public.usage_log, public.activity_log TO ricotdin_worker;

DO $$
DECLARE
  r record;
  kept constant text[] := ARRAY[
    'meetings', 'jobs', 'transcript_segments', 'transcript_chunks', 'todos',
    'calendar_suggestions', 'storage_objects', 'admin_config', 'app_config', 'app_settings',
    'quota_wallets', 'profiles', 'usage_log', 'activity_log'];
BEGIN
  -- Policies: the worker leaves service_all on every table it no longer reaches.
  FOR r IN
    SELECT tablename FROM pg_policies
    WHERE schemaname = 'public' AND policyname = 'service_all'
      AND 'ricotdin_worker' = ANY (roles) AND tablename <> ALL (kept)
  LOOP
    EXECUTE format('ALTER POLICY service_all ON public.%I TO ricotdin_service', r.tablename);
  END LOOP;

  -- Functions: no explicit grant but claim_next_job (the quota wrappers are granted below).
  FOR r IN
    SELECT DISTINCT p.oid::regprocedure AS fn
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace,
         aclexplode(p.proacl) x
    JOIN pg_roles g ON g.oid = x.grantee
    WHERE n.nspname = 'public' AND g.rolname = 'ricotdin_worker'
      AND p.proname <> 'claim_next_job'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM ricotdin_worker', r.fn);
  END LOOP;
END $$;

-- 3. pipeline quota wrappers -------------------------------------------------------------------
-- 86400 s: a sanity bound for one recording (the worker refuses longer audio earlier).
CREATE FUNCTION public.pipeline_reserve(p_job_id uuid, p_seconds bigint)
 RETURNS TABLE(status text, audio_remaining bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_meeting uuid;
  v_user uuid;
BEGIN
  IF p_seconds IS NULL OR p_seconds <= 0 OR p_seconds > 86400 THEN
    RAISE EXCEPTION 'pipeline_reserve: seconds out of range' USING ERRCODE = '22023';
  END IF;
  -- One quota movement per job at a time (reserve / refund / settle): the checks below and the
  -- insert happen under this lock until the transaction ends.
  PERFORM pg_advisory_xact_lock(hashtext('gen:' || p_job_id::text));
  SELECT j.meeting_id, m.user_id INTO v_meeting, v_user
  FROM public.jobs j JOIN public.meetings m ON m.id = j.meeting_id
  WHERE j.id = p_job_id AND j.status = 'running';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pipeline_reserve: no running job' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT q.status, q.audio_remaining
    FROM public.quota_apply_movement(
      v_user, -p_seconds, 0, 'generate', 'gen:' || p_job_id || ':reserve', false, v_meeting,
      NULL, jsonb_build_object('estimate_seconds', p_seconds)) q;
END;
$function$;

-- Gives back exactly the reserved amount, once, for a failed job (the runner marks the job failed
-- first, in the same transaction); nothing when nothing was reserved by this job or the reserve was
-- already settled.
CREATE FUNCTION public.pipeline_refund(p_job_id uuid)
 RETURNS TABLE(status text, refunded bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user uuid;
  v_meeting uuid;
  v_reserved bigint;
BEGIN
  -- One quota movement per job at a time (reserve / refund / settle): the checks below and the
  -- insert happen under this lock until the transaction ends.
  PERFORM pg_advisory_xact_lock(hashtext('gen:' || p_job_id::text));
  IF NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = p_job_id AND j.status = 'failed') THEN
    RAISE EXCEPTION 'pipeline_refund: no failed job' USING ERRCODE = '22023';
  END IF;
  SELECT l.user_id, l.meeting_id, -l.delta_audio_seconds INTO v_user, v_meeting, v_reserved
  FROM public.quota_ledger l WHERE l.dedup_key = 'gen:' || p_job_id || ':reserve';
  IF NOT FOUND OR v_reserved <= 0 THEN
    RETURN QUERY SELECT 'nothing_reserved'::text, 0::bigint;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.quota_ledger WHERE dedup_key = 'gen:' || p_job_id || ':settle') THEN
    RETURN QUERY SELECT 'settled'::text, 0::bigint;
    RETURN;
  END IF;
  RETURN QUERY
    SELECT q.status, v_reserved
    FROM public.quota_apply_movement(
      v_user, v_reserved, 0, 'refund', 'gen:' || p_job_id || ':refund', false, v_meeting, NULL,
      jsonb_build_object('reason', 'pipeline_failure')) q;
END;
$function$;

-- 08b: reserved − actual (refund or extra charge), once, for a running job. No settle after a
-- refund.
CREATE FUNCTION public.pipeline_settle(p_job_id uuid, p_actual_seconds bigint)
 RETURNS TABLE(status text, delta bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user uuid;
  v_meeting uuid;
  v_reserved bigint;
BEGIN
  IF p_actual_seconds IS NULL OR p_actual_seconds < 0 OR p_actual_seconds > 86400 THEN
    RAISE EXCEPTION 'pipeline_settle: seconds out of range' USING ERRCODE = '22023';
  END IF;
  -- One quota movement per job at a time (reserve / refund / settle): the checks below and the
  -- insert happen under this lock until the transaction ends.
  PERFORM pg_advisory_xact_lock(hashtext('gen:' || p_job_id::text));
  IF NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = p_job_id AND j.status = 'running') THEN
    RAISE EXCEPTION 'pipeline_settle: no running job' USING ERRCODE = '22023';
  END IF;
  SELECT l.user_id, l.meeting_id, -l.delta_audio_seconds INTO v_user, v_meeting, v_reserved
  FROM public.quota_ledger l WHERE l.dedup_key = 'gen:' || p_job_id || ':reserve';
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'nothing_reserved'::text, 0::bigint;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.quota_ledger WHERE dedup_key = 'gen:' || p_job_id || ':refund') THEN
    RETURN QUERY SELECT 'refunded'::text, 0::bigint;
    RETURN;
  END IF;
  RETURN QUERY
    SELECT q.status, v_reserved - p_actual_seconds
    FROM public.quota_apply_movement(
      v_user, v_reserved - p_actual_seconds, 0, 'generate', 'gen:' || p_job_id || ':settle',
      true, v_meeting, NULL,
      jsonb_build_object('estimate_seconds', v_reserved, 'real_seconds', p_actual_seconds)) q;
END;
$function$;

REVOKE ALL ON FUNCTION public.pipeline_reserve(uuid, bigint), public.pipeline_refund(uuid),
  public.pipeline_settle(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pipeline_reserve(uuid, bigint), public.pipeline_refund(uuid),
  public.pipeline_settle(uuid, bigint) TO ricotdin_worker;
