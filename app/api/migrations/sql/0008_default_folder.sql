-- PRF-07: a user's default folder for new meetings.
--
-- POST /meetings uses it when the request sends no folderId. The API checks that the user may
-- add meetings to the folder (owner, or shared as editor) both when it is set and when it is used.
-- Deleting the folder clears it (ON DELETE SET NULL; referential actions run as the table owner,
-- so RLS does not stop them). The app role may set it on its own row (profiles_update policy).

ALTER TABLE public.profiles
  ADD COLUMN default_folder_id uuid NULL REFERENCES public.folders (id) ON DELETE SET NULL;
CREATE INDEX profiles_default_folder_id
  ON public.profiles (default_folder_id) WHERE default_folder_id IS NOT NULL;

GRANT UPDATE (default_folder_id) ON public.profiles TO ricotdin_app;
