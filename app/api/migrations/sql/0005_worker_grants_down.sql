-- Reverse of 0005_worker_grants.sql: back to the 0004 privileges of ricotdin_worker (0002: the
-- service's privileges minus the auth tables; 0003: drive_config SELECT) and no unique index.
-- Jobs failed as duplicates by the upgrade stay failed.
DROP INDEX IF EXISTS public.jobs_one_active_per_meeting;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ricotdin_worker;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.admin_config, public.app_config, public.app_settings, public.calendar_suggestions,
     public.chat_messages, public.chat_sessions, public.features, public.folder_shares,
     public.folders, public.jobs, public.meetings, public.profiles, public.quota_wallets,
     public.storage_config, public.storage_objects, public.todos, public.transcript_chunks,
     public.transcript_segments, public.usage_log
  TO ricotdin_worker;
GRANT SELECT, INSERT ON public.activity_log, public.audit_logs, public.quota_ledger
  TO ricotdin_worker;
GRANT SELECT ON public.drive_config TO ricotdin_worker;

ALTER POLICY service_all ON public.folders TO ricotdin_service, ricotdin_worker;
ALTER POLICY service_all ON public.folder_shares TO ricotdin_service, ricotdin_worker;
ALTER POLICY service_all ON public.chat_sessions TO ricotdin_service, ricotdin_worker;
ALTER POLICY service_all ON public.chat_messages TO ricotdin_service, ricotdin_worker;
ALTER POLICY service_all ON public.features TO ricotdin_service, ricotdin_worker;
ALTER POLICY service_all ON public.storage_config TO ricotdin_service, ricotdin_worker;
ALTER POLICY service_all ON public.quota_ledger TO ricotdin_service, ricotdin_worker;

-- 0002 granted the worker EXECUTE wherever the service had it.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT p.oid::regprocedure AS fn
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace,
         aclexplode(p.proacl) x
    JOIN pg_roles g ON g.oid = x.grantee
    WHERE n.nspname = 'public' AND g.rolname = 'ricotdin_service' AND x.privilege_type = 'EXECUTE'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ricotdin_worker', r.fn);
  END LOOP;
END $$;
