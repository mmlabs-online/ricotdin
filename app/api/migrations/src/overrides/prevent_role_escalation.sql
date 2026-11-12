-- v2 version of v1 migration 001's trigger function (ARC-02). v1 read the PostgREST setting
-- request.jwt.claims and allowed any call without claims. v2 decides by the *invoking role*
-- (SECURITY INVOKER, so current_user is the caller): the API role ricotdin_app may change a role
-- only with an admin request context; ricotdin_service, the owner and SECURITY DEFINER callers
-- such as sync_profile_role may. A forgotten request context therefore fails closed.
CREATE FUNCTION public.prevent_role_escalation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if old.role is distinct from new.role
     and current_user = 'ricotdin_app'
     and coalesce(public.app_user_role(), '') <> 'admin' then
    raise exception 'Only admins can change user roles'
      using errcode = 'P0001',
            hint    = 'Use the /admin/users route to change roles.';
  end if;
  return new;
end;
$function$
