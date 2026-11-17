REVOKE UPDATE (speaker_names) ON public.meetings FROM ricotdin_worker;
ALTER TABLE public.meetings DROP CONSTRAINT IF EXISTS meetings_speaker_names_object;
ALTER TABLE public.meetings DROP COLUMN IF EXISTS speaker_names;
