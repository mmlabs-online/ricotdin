-- PRO-04: names people give to the diarizer's speaker labels, per meeting ({"Speaker 1": "Lan"}).
-- Written by the API as ricotdin_service after an editor check; the app role reads it (table grant).
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS speaker_names jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.meetings DROP CONSTRAINT IF EXISTS meetings_speaker_names_object;
ALTER TABLE public.meetings ADD CONSTRAINT meetings_speaker_names_object
  CHECK (jsonb_typeof(speaker_names) = 'object');
-- The worker clears the names when a new transcription replaces the segments (the diarizer
-- numbers the voices afresh): it may update this one column too.
GRANT UPDATE (speaker_names) ON public.meetings TO ricotdin_worker;
