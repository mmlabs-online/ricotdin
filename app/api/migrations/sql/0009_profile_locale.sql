-- PRF-06: the user's UI language, saved on the account (NULL = follow the device/browser).
-- The app writes it through PATCH /profile/preferences (own row, existing RLS UPDATE policy).
ALTER TABLE public.profiles
  ADD COLUMN locale text NULL CONSTRAINT profiles_locale_check CHECK (locale IN ('en', 'vi'));

GRANT UPDATE (locale) ON public.profiles TO ricotdin_app;
