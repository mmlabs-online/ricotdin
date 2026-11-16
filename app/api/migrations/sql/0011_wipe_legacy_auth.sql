-- AUT-06: ricotdin's own password / refresh / email-link auth is gone (sign-in is mmlabs, AUT-05).
-- Wipe the credentials it left behind; the schema stays (the tables and users.password_hash are
-- dropped with ARC-16 part 2, together with the v1 migration tooling that still reads them).
UPDATE public.users SET password_hash = NULL WHERE password_hash IS NOT NULL;
DELETE FROM public.refresh_tokens;
DELETE FROM public.email_tokens;
