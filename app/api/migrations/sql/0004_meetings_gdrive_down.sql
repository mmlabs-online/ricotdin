-- Reverse of 0004_meetings_gdrive.sql. Refuses while v2 meetings reference Drive.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.meetings WHERE storage_provider = 'gdrive') THEN
    RAISE EXCEPTION 'meetings with storage_provider = gdrive exist; cannot downgrade';
  END IF;
END $$;
ALTER TABLE public.meetings ALTER COLUMN storage_provider SET DEFAULT 'supabase';
ALTER TABLE public.meetings DROP CONSTRAINT meetings_storage_provider_check;
ALTER TABLE public.meetings ADD CONSTRAINT meetings_storage_provider_check
  CHECK (storage_provider = ANY (ARRAY['supabase'::text, 'r2'::text]));
COMMENT ON COLUMN public.meetings.storage_provider IS 'Object-storage backend for audio_path: "supabase" = legacy Supabase Storage, "r2" = Cloudflare R2 (CST-02+).';
