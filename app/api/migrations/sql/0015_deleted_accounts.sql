-- PRF-13 review: what is left of a deleted account — the sha256 of its mmlabs `sub` and when.
-- No email, no name, no FK (the user row is gone). Read on an mmlabs account's first request:
-- a token issued before the delete is refused, a newer sign-in gets an account without a second
-- signup grant. ricotdin_service only.
CREATE TABLE IF NOT EXISTS public.deleted_accounts (
  sub_hash text PRIMARY KEY CHECK (sub_hash ~ '^[0-9a-f]{64}$'),
  deleted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.deleted_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_all ON public.deleted_accounts;
CREATE POLICY service_all ON public.deleted_accounts AS PERMISSIVE FOR ALL
  TO ricotdin_service USING (true) WITH CHECK (true);
REVOKE ALL ON public.deleted_accounts FROM PUBLIC, ricotdin_app, ricotdin_worker;
GRANT SELECT, INSERT, UPDATE ON public.deleted_accounts TO ricotdin_service;
