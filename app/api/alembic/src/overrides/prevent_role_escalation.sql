-- v2 version of v1 migration 001's trigger function (ARC-02). v1 read the PostgREST setting
-- request.jwt.claims; v2 reads the RLS request context. Same rule: no user context
-- (service/worker) may change roles, a user context must be an admin.
CREATE FUNCTION public.prevent_role_escalation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if old.role is distinct from new.role then
    -- No request context = service-role or superuser call → allow role changes.
    if public.app_user_id() is null then
      return new;
    end if;
    if coalesce(public.app_user_role(), 'user') <> 'admin' then
      raise exception 'Only admins can change user roles'
        using errcode = 'P0001',
              hint    = 'Use the /admin/users route to change roles.';
    end if;
  end if;
  return new;
end;
$function$
