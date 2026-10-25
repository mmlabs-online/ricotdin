-- ARC-04: split the runtime service role and make the log tables append-only.
--   ricotdin_service — auth endpoints + admin operations (users, tokens, keys, everything).
--   ricotdin_worker  — pipeline worker + schedulers: like ricotdin_service but WITHOUT access to
--                      users / refresh_tokens / email_tokens (untrusted audio and LLM output
--                      must never sit next to password hashes).
--   No runtime role may UPDATE / DELETE / TRUNCATE audit_logs, activity_log, quota_ledger.
--   Service roles lose TRUNCATE / TRIGGER / REFERENCES / MAINTAIN (not governed by RLS).
-- Cascades from user deletion still remove log rows: FK actions run with the owner's rights.
SET LOCAL check_function_bodies = false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ricotdin_worker') THEN
    CREATE ROLE ricotdin_worker NOLOGIN;
  END IF;
END $$;
ALTER ROLE ricotdin_worker NOLOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT USAGE ON SCHEMA public TO ricotdin_worker;

DO $$
DECLARE
  r record;
  auth_tables constant text[] := ARRAY['users', 'refresh_tokens', 'email_tokens'];
BEGIN
  -- Worker: the service's table privileges, minus the auth tables.
  FOR r IN
    SELECT c.relname, x.privilege_type
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace,
         aclexplode(c.relacl) x
    JOIN pg_roles g ON g.oid = x.grantee
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND g.rolname = 'ricotdin_service'
      AND c.relname <> ALL (auth_tables)
  LOOP
    EXECUTE format('GRANT %s ON public.%I TO ricotdin_worker', r.privilege_type, r.relname);
  END LOOP;

  -- Worker: EXECUTE wherever the service has it (claim_next_job, quota_apply_movement, ...).
  FOR r IN
    SELECT p.oid::regprocedure AS fn
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace,
         aclexplode(p.proacl) x
    JOIN pg_roles g ON g.oid = x.grantee
    WHERE n.nspname = 'public' AND g.rolname = 'ricotdin_service' AND x.privilege_type = 'EXECUTE'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ricotdin_worker', r.fn);
  END LOOP;

  -- Worker: the permissive service_all policy on every non-auth table.
  FOR r IN
    SELECT tablename FROM pg_policies
    WHERE schemaname = 'public' AND policyname = 'service_all' AND tablename <> ALL (auth_tables)
  LOOP
    EXECUTE format('ALTER POLICY service_all ON public.%I TO ricotdin_service, ricotdin_worker', r.tablename);
  END LOOP;

  -- Service roles: no privileges that RLS does not govern.
  FOR r IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    EXECUTE format(
      'REVOKE TRUNCATE, TRIGGER, REFERENCES, MAINTAIN ON public.%I FROM ricotdin_service, ricotdin_worker',
      r.relname
    );
  END LOOP;
END $$;

-- Append-only logs for every runtime role.
REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_logs, public.activity_log, public.quota_ledger
  FROM ricotdin_app, ricotdin_service, ricotdin_worker;
