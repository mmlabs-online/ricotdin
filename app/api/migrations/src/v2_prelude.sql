-- ---------------------------------------------------------------------------------------------
-- v2 prelude (ARC-02, hand-written): roles, RLS request context, own auth tables.
-- Runs after the extensions and before the objects ported from v1.
-- ---------------------------------------------------------------------------------------------

-- Roles are cluster-wide: create them idempotently and never drop them on downgrade.
--   ricotdin_app     — API requests. RLS applies; privileges mirror Supabase `authenticated`
--                      after v1's revoke migrations (033–038).
--   ricotdin_service — worker, schedulers and admin/auth operations. Gets a permissive
--                      `service_all` policy on every RLS table (no BYPASSRLS needed).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ricotdin_app') THEN
    CREATE ROLE ricotdin_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ricotdin_service') THEN
    CREATE ROLE ricotdin_service NOLOGIN;
  END IF;
END $$;
-- A pre-existing role must not keep LOGIN / BYPASSRLS from somewhere else.
ALTER ROLE ricotdin_app NOLOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE ricotdin_service NOLOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE;

GRANT USAGE ON SCHEMA public TO ricotdin_app, ricotdin_service;

-- Hardening (ARC-02 security review). v1 was only reachable through PostgREST; v2 runs SQL.
--   * no temp objects: a temp table could shadow public tables inside SECURITY DEFINER code;
--   * no CREATE in public for anyone but the owner (PG15+ default, made explicit);
--   * functions created by later migrations are not executable by PUBLIC by default (BUG-005).
DO $$ BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- RLS request context. The API sets both per transaction (ARC-04):
--   SET LOCAL app.user_id = '<uuid>'; SET LOCAL app.role = 'user' | 'admin';
-- Unset = no user context (service/worker), exactly like a missing JWT in v1.
CREATE FUNCTION public.app_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION public.app_user_role() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.role', true), '') $$;

-- Own auth tables (replace Supabase auth.users). Never readable by ricotdin_app.
CREATE TABLE public.users (
  id                uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email             text        NOT NULL,
  password_hash     text        NOT NULL,           -- argon2id; migrated bcrypt rehashed on login
  role              text        NOT NULL DEFAULT 'user',
  email_verified_at timestamptz,
  disabled_at       timestamptz,                    -- set = admin-disabled (v1 banned_until)
  last_sign_in_at   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_role_values CHECK (role IN ('admin', 'user'))
);
CREATE UNIQUE INDEX users_email_lower_key ON public.users (lower(email));
COMMENT ON TABLE public.users IS
  'Auth identity (replaces Supabase auth.users). Role is authoritative here; profiles.role mirrors it.';

CREATE TABLE public.refresh_tokens (
  id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  family_id   uuid        NOT NULL,                 -- rotation chain; reuse revokes the family
  token_hash  text        NOT NULL UNIQUE,          -- sha-256 of the opaque token, never the token
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid        REFERENCES public.refresh_tokens (id) ON DELETE SET NULL,
  user_agent  text,
  ip          text
);
CREATE INDEX idx_refresh_tokens_user   ON public.refresh_tokens (user_id);
CREATE INDEX idx_refresh_tokens_family ON public.refresh_tokens (family_id);
CREATE INDEX idx_refresh_tokens_expires ON public.refresh_tokens (expires_at);

CREATE TABLE public.email_tokens (
  id         uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  purpose    text        NOT NULL,
  token_hash text        NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,                           -- single use
  CONSTRAINT email_tokens_purpose_values CHECK (purpose IN ('verify_email', 'reset_password'))
);
CREATE INDEX idx_email_tokens_user_purpose ON public.email_tokens (user_id, purpose);
CREATE INDEX idx_email_tokens_expires ON public.email_tokens (expires_at);

ALTER TABLE public.users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_tokens   ENABLE ROW LEVEL SECURITY;
-- Only ricotdin_service touches these (auth endpoints, admin); same service_all pattern as the
-- ported v1 tables.
CREATE POLICY service_all ON public.users AS PERMISSIVE FOR ALL
  TO ricotdin_service USING (true) WITH CHECK (true);
CREATE POLICY service_all ON public.refresh_tokens AS PERMISSIVE FOR ALL
  TO ricotdin_service USING (true) WITH CHECK (true);
CREATE POLICY service_all ON public.email_tokens AS PERMISSIVE FOR ALL
  TO ricotdin_service USING (true) WITH CHECK (true);
REVOKE ALL ON public.users, public.refresh_tokens, public.email_tokens FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users, public.refresh_tokens, public.email_tokens
  TO ricotdin_service;
