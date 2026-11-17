ALTER TABLE public.meetings DROP CONSTRAINT IF EXISTS meetings_speaker_names_object;
ALTER TABLE public.meetings DROP COLUMN IF EXISTS speaker_names;
