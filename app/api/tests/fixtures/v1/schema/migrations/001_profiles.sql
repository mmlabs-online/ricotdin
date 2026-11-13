-- ============================================================================
-- Migration 001: profiles table (Phase 7 auth)
-- ============================================================================
-- Apply in the Supabase dashboard → SQL editor (or via supabase db push).
-- This is additive; no existing tables are modified.
--
-- Security design:
--   * Role is stored in both app_metadata (JWT source) and here (display/join).
--   * The `authenticated` role can only UPDATE the username column — Postgres
--     column-level privileges prevent touching `role` from the browser.
--   * A belt-and-suspenders trigger raises an exception if a non-admin somehow
--     attempts a role change (e.g. via a raw SQL connection).
--   * Registration and role changes always use the service role key (server-side).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Table
-- ----------------------------------------------------------------------------
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  username   text unique not null,
  role       text not null default 'user',
  created_at timestamptz not null default now(),

  constraint profiles_username_length  check (length(username) >= 3 and length(username) <= 30),
  constraint profiles_username_charset check (username ~ '^[a-z0-9_-]+$'),
  constraint profiles_role_values      check (role in ('admin', 'user'))
);

comment on table public.profiles is
  'One row per auth.users entry. Stores username and role (synced with app_metadata).';


-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------
alter table public.profiles enable row level security;

-- Each user can read their own profile.
-- Admins (role claim injected by the custom access token hook) can read all.
create policy "profiles_select"
  on public.profiles for select
  using (
    auth.uid() = id
    or auth.jwt()->>'user_role' = 'admin'
  );

-- Each user can update their own row.
-- Column-level privileges (below) restrict WHICH columns they may change.
create policy "profiles_update"
  on public.profiles for update
  using  (auth.uid() = id)
  with check (auth.uid() = id);

-- No INSERT or DELETE policies for authenticated users — those operations are
-- performed server-side via the service role key (which bypasses RLS).


-- ----------------------------------------------------------------------------
-- Column-level privilege: authenticated role may NOT update `role`
-- ----------------------------------------------------------------------------
-- Revoke the broad UPDATE and re-grant only on the safe column.
-- The service role key bypasses these restrictions and can update any column.
revoke update on public.profiles from authenticated;
grant  update (username) on public.profiles to authenticated;


-- ----------------------------------------------------------------------------
-- Belt-and-suspenders trigger: block role changes from non-admins
-- ----------------------------------------------------------------------------
-- Catches direct DB connections or SDK calls that somehow bypass the column
-- privilege. Reads the JWT role claim set by our custom access token hook.
create or replace function public.prevent_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  jwt_claims text;
  caller_role text;
begin
  if old.role is distinct from new.role then
    jwt_claims := current_setting('request.jwt.claims', true);

    -- No JWT claims = service-role or superuser call → allow role changes.
    if jwt_claims is null or jwt_claims = '' then
      return new;
    end if;

    caller_role := coalesce((jwt_claims::jsonb)->>'user_role', 'user');

    if caller_role != 'admin' then
      raise exception 'Only admins can change user roles'
        using errcode = 'P0001',
              hint    = 'Use the /api/admin/users route to change roles.';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_prevent_role_escalation
  before update on public.profiles
  for each row execute function public.prevent_role_escalation();
