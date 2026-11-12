-- PRF-06 down: the UI language preference goes (the column grant goes with the column).
ALTER TABLE public.profiles DROP COLUMN IF EXISTS locale;
