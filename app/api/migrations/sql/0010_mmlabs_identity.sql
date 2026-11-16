-- AUT-05: ricotdin users signed in with an mmlabs account (org-admin-api identity).
-- users.mmlabs_sub = the mmlabs user id (token `sub`); NULL until the first mmlabs sign-in.
-- password_hash becomes optional: accounts created from mmlabs have no ricotdin password.
-- No new grant: ricotdin_service already has SELECT/INSERT/UPDATE on users (0001).
ALTER TABLE public.users ADD COLUMN mmlabs_sub text;
ALTER TABLE public.users ADD CONSTRAINT users_mmlabs_sub_key UNIQUE (mmlabs_sub);
ALTER TABLE public.users ADD CONSTRAINT users_mmlabs_sub_length
  CHECK (mmlabs_sub IS NULL OR length(mmlabs_sub) BETWEEN 1 AND 255);
ALTER TABLE public.users ALTER COLUMN password_hash DROP NOT NULL;
COMMENT ON COLUMN public.users.mmlabs_sub IS
  'mmlabs identity user id (AUT-05); set on the first mmlabs sign-in, never changed.';
