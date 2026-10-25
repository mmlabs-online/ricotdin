-- Reverse of 0002_runtime_roles.sql: back to the 0001 privileges. The ricotdin_worker role is
-- cluster-wide and kept; only its privileges in this database are removed.
DO $$
DECLARE
  r record;
  auth_tables constant text[] := ARRAY['users', 'refresh_tokens', 'email_tokens'];
BEGIN
  FOR r IN
    SELECT tablename FROM pg_policies
    WHERE schemaname = 'public' AND policyname = 'service_all' AND tablename <> ALL (auth_tables)
  LOOP
    EXECUTE format('ALTER POLICY service_all ON public.%I TO ricotdin_service', r.tablename);
  END LOOP;

  -- 0001: ricotdin_service had ALL on every ported v1 table (not on the v2 auth tables).
  FOR r IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> ALL (auth_tables)
  LOOP
    EXECUTE format('GRANT TRUNCATE, TRIGGER, REFERENCES, MAINTAIN ON public.%I TO ricotdin_service', r.relname);
  END LOOP;
END $$;

GRANT UPDATE, DELETE ON public.audit_logs, public.activity_log, public.quota_ledger TO ricotdin_service;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ricotdin_worker;
-- Only functions the worker was granted: a blanket REVOKE would turn default (NULL) ACLs into
-- explicit ones and the schema would no longer match 0001 exactly.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT p.oid::regprocedure AS fn
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace,
         aclexplode(p.proacl) x
    JOIN pg_roles g ON g.oid = x.grantee
    WHERE n.nspname = 'public' AND g.rolname = 'ricotdin_worker'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM ricotdin_worker', r.fn);
  END LOOP;
END $$;
REVOKE USAGE ON SCHEMA public FROM ricotdin_worker;
