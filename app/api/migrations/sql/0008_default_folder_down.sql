-- PRF-07 down: the default folder preference goes (the column grant goes with the column).
DROP INDEX IF EXISTS public.profiles_default_folder_id;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS default_folder_id;
