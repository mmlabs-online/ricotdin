-- Migration 034: SECURITY DEFINER RPCs callable only by the service role (BUG-005)
--
-- quota_apply_movement (migration 020) and claim_next_job (migration 021) are
-- SECURITY DEFINER, so they run as the function owner and bypass RLS. Their comments
-- assumed "no GRANT = not callable", but Postgres grants EXECUTE on new functions to
-- PUBLIC by default (and Supabase default privileges also grant anon/authenticated).
-- So any signed-in user could call them through PostgREST
-- (POST /rest/v1/rpc/quota_apply_movement), e.g. to mint quota for any user, or
-- claim/stall pipeline jobs and read job rows.
--
-- Safe: both are only called by server code using the service-role client
-- (lib/quota/applyQuotaMovement.ts, lib/jobs/worker.ts). service_role keeps EXECUTE.
--
-- Verify after applying (expect anon/authenticated = false, service_role = true for both):
--   select r.role, f.fn, has_function_privilege(r.role, f.fn, 'execute') as can_execute
--   from (values ('anon'), ('authenticated'), ('service_role')) r(role),
--        (values ('public.quota_apply_movement(uuid,bigint,int,text,text,boolean,uuid,uuid,jsonb)'),
--                ('public.claim_next_job(text)')) f(fn);
--
-- Rollback:
--   GRANT EXECUTE ON FUNCTION public.quota_apply_movement(uuid, bigint, int, text, text, boolean, uuid, uuid, jsonb) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.claim_next_job(text) TO PUBLIC;

REVOKE EXECUTE ON FUNCTION public.quota_apply_movement(uuid, bigint, int, text, text, boolean, uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quota_apply_movement(uuid, bigint, int, text, text, boolean, uuid, uuid, jsonb)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.claim_next_job(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_job(text)
  TO service_role;
