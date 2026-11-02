-- ARC-07 part 2: meetings created by v2 store their audio in Google Drive (ARC-17).
ALTER TABLE public.meetings DROP CONSTRAINT meetings_storage_provider_check;
ALTER TABLE public.meetings ADD CONSTRAINT meetings_storage_provider_check
  CHECK (storage_provider = ANY (ARRAY['supabase'::text, 'r2'::text, 'gdrive'::text]));
ALTER TABLE public.meetings ALTER COLUMN storage_provider SET DEFAULT 'gdrive';
COMMENT ON COLUMN public.meetings.storage_provider IS
  'Object-storage backend for audio_path: "supabase" = legacy Supabase Storage, "r2" = Cloudflare R2 (v1), "gdrive" = Google Drive (v2, ARC-17; key mapped in storage_objects).';
