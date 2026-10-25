-- ---------------------------------------------------------------------------------------------
-- v2 epilogue (ARC-02, hand-written): wiring that needs the ported v1 objects to exist.
-- ---------------------------------------------------------------------------------------------

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- profiles.role mirrors users.role (v1 kept app_metadata.role and profiles.role in sync from
-- the API; v2 does it in the database so no code path can update only one of them).
CREATE FUNCTION public.sync_profile_role() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  update public.profiles set role = new.role where id = new.id and role is distinct from new.role;
  return new;
end;
$function$;
REVOKE ALL ON FUNCTION public.sync_profile_role() FROM PUBLIC;

CREATE TRIGGER trg_users_sync_profile_role
  AFTER UPDATE OF role ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.sync_profile_role();
