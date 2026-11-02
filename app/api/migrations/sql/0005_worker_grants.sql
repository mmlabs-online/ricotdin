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
--      jobs                SELECT, UPDATE (claim_next_job is SECURITY DEFINER; no INSERT/DELETE)
--      transcript_segments, transcript_chunks, todos, calendar_suggestions
--                          SELECT, INSERT, UPDATE, DELETE (pipeline output, reprocess cleanup)
--      storage_objects     SELECT, INSERT, UPDATE, DELETE (0003: download, purge; /media lookup)
--      drive_config        SELECT (0003)
--      admin_config        SELECT; UPDATE of health_status / health_checked_at / health_detail /
--                          last_used_at (key health check)
--      app_config, app_settings, quota_wallets   SELECT
--      profiles            SELECT (id, default_provider, default_model) — model resolution
--      usage_log, activity_log, audit_logs       INSERT (append-only logs)
--      EXECUTE             claim_next_job, quota_apply_movement (both SECURITY DEFINER; the
--                          quota ledger itself stays out of reach)
--    Everything else is revoked: users / tokens (already), folders, folder_shares, chat_*,
--    features, storage_config (v1 R2 secret), quota_ledger, and the other functions.
--    The permissive service_all policy keeps the worker only on the tables it keeps.
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
GRANT SELECT, UPDATE ON public.jobs TO ricotdin_worker;
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
GRANT INSERT ON public.usage_log, public.activity_log, public.audit_logs TO ricotdin_worker;

DO $$
DECLARE
  r record;
  kept constant text[] := ARRAY[
    'meetings', 'jobs', 'transcript_segments', 'transcript_chunks', 'todos',
    'calendar_suggestions', 'storage_objects', 'admin_config', 'app_config', 'app_settings',
    'quota_wallets', 'profiles', 'usage_log', 'activity_log', 'audit_logs'];
BEGIN
  -- Policies: the worker leaves service_all on every table it no longer reaches.
  FOR r IN
    SELECT tablename FROM pg_policies
    WHERE schemaname = 'public' AND policyname = 'service_all'
      AND 'ricotdin_worker' = ANY (roles) AND tablename <> ALL (kept)
  LOOP
    EXECUTE format('ALTER POLICY service_all ON public.%I TO ricotdin_service', r.tablename);
  END LOOP;

  -- Functions: only the two SECURITY DEFINER entry points the pipeline calls.
  FOR r IN
    SELECT DISTINCT p.oid::regprocedure AS fn
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace,
         aclexplode(p.proacl) x
    JOIN pg_roles g ON g.oid = x.grantee
    WHERE n.nspname = 'public' AND g.rolname = 'ricotdin_worker'
      AND p.proname NOT IN ('claim_next_job', 'quota_apply_movement')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM ricotdin_worker', r.fn);
  END LOOP;
END $$;
