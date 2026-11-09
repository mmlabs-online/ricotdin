-- PRO-06: version history of a meeting's summary and notes.
--
-- Each row holds the text a field had from that moment on (the newest row of a field is its
-- current text). Written only by the API as ricotdin_service (edit, restore, regenerate), at most
-- 50 rows per meeting + field (older rows are deleted by the API). Readable by the app role under
-- RLS for anyone who can view the meeting; the worker has no access. Never updated.

CREATE TABLE public.meeting_note_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,  -- order of writes (never a clock)
  meeting_id uuid NOT NULL REFERENCES public.meetings (id) ON DELETE CASCADE,
  field text NOT NULL CHECK (field IN ('summary', 'notes')),
  content text NOT NULL CHECK (char_length(content) <= 200000),  -- = AI notes limit
  source text NOT NULL CHECK (source IN ('ai', 'user', 'restore')),
  edited_by uuid NULL REFERENCES public.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX meeting_note_versions_by_field
  ON public.meeting_note_versions (meeting_id, field, seq DESC);
CREATE INDEX meeting_note_versions_edited_by
  ON public.meeting_note_versions (edited_by) WHERE edited_by IS NOT NULL;

ALTER TABLE public.meeting_note_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY meeting_note_versions_select ON public.meeting_note_versions AS PERMISSIVE
  FOR SELECT TO ricotdin_app USING (public.can_access_meeting(meeting_id, 'viewer'));
CREATE POLICY service_all ON public.meeting_note_versions AS PERMISSIVE FOR ALL
  TO ricotdin_service USING (true) WITH CHECK (true);

REVOKE ALL ON public.meeting_note_versions FROM PUBLIC, ricotdin_app, ricotdin_service,
  ricotdin_worker;
GRANT SELECT ON public.meeting_note_versions TO ricotdin_app;
GRANT SELECT, INSERT, DELETE ON public.meeting_note_versions TO ricotdin_service;
