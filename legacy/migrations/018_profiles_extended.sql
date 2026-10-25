-- Migration 018: extend profiles table for PRF-01..05
-- Adds display_name, avatar_key, theme_preference columns.
-- Expands the column-level UPDATE grant so users can self-edit these fields.
-- Role remains non-self-editable (revoke/grant + prevent_role_escalation trigger unchanged).

alter table public.profiles
  add column if not exists display_name     text null,
  add column if not exists avatar_key       text null,
  add column if not exists theme_preference text null
    constraint profiles_theme_preference_check
      check (theme_preference in ('luxury', 'default', 'playful'));

-- Re-apply column-level privilege to include the new columns.
-- The original migration 001 granted only (username); we widen it here.
-- Role is deliberately absent — it must never be self-editable.
revoke update on public.profiles from authenticated;
grant update (username, display_name, avatar_key, theme_preference)
  on public.profiles to authenticated;
