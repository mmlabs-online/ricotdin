-- ============================================================================
-- Migration 002: custom access token hook (Phase 7 auth)
-- ============================================================================
-- Injects `user_role` into the JWT so RLS policies can check it without a
-- subquery. The role is read from app_metadata (only writable by service role).
--
-- After applying this SQL, you MUST enable the hook in the Supabase dashboard:
--   Authentication → Hooks → Custom Access Token → select this function
--   (public.custom_access_token_hook)
-- ============================================================================


create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims    jsonb;
  user_role text;
begin
  -- Read the role from app_metadata, which is only settable by the service role.
  -- Falls back to 'user' if not set (e.g. legacy / anonymous rows).
  user_role := coalesce(
    event -> 'claims' -> 'app_metadata' ->> 'role',
    'user'
  );

  claims := event -> 'claims';
  claims := jsonb_set(claims, '{user_role}', to_jsonb(user_role));

  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- Supabase's hook runner must be able to call this function.
grant execute on function public.custom_access_token_hook to supabase_auth_admin;

-- Nobody else needs to call it directly.
revoke execute on function public.custom_access_token_hook
  from authenticated, anon, public;
