-- Accounts created from mmlabs have no password: give them an unusable one (no hash scheme
-- matches it, so a password sign-in always fails) before the column is NOT NULL again.
UPDATE public.users SET password_hash = '!mmlabs' WHERE password_hash IS NULL;
ALTER TABLE public.users ALTER COLUMN password_hash SET NOT NULL;
ALTER TABLE public.users DROP CONSTRAINT users_mmlabs_sub_length;
ALTER TABLE public.users DROP CONSTRAINT users_mmlabs_sub_key;
ALTER TABLE public.users DROP COLUMN mmlabs_sub;
