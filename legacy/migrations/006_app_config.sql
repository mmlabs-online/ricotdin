-- Migration 006: app_config table
-- Key-value store for admin-configurable feature flags and settings.
-- Readable by admin via RLS; writes only via service role (server-side PATCH route).

CREATE TABLE IF NOT EXISTS public.app_config (
  key         text        PRIMARY KEY,
  value       jsonb       NOT NULL,
  description text        NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL
);

-- RLS: admins can SELECT; nobody can write from the browser (service role only)
ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin read app_config"
  ON public.app_config
  FOR SELECT
  TO authenticated
  USING (auth.jwt()->>'user_role' = 'admin');

-- Trigger: keep updated_at current on every update
CREATE OR REPLACE FUNCTION public.touch_app_config_updated_at()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER app_config_updated_at
  BEFORE UPDATE ON public.app_config
  FOR EACH ROW EXECUTE FUNCTION public.touch_app_config_updated_at();

-- Seed with sensible defaults
INSERT INTO public.app_config (key, value, description) VALUES
  ('pipeline.model',          '"gemini-2.5-flash"',    'Gemini model used for the processing pipeline'),
  ('pipeline.max_retries',    '3',                     'Max retry attempts on Gemini 429 errors'),
  ('pipeline.chunk_minutes',  '25',                    'Audio chunk size in minutes for long recordings'),
  ('rag.top_k',               '5',                     'Number of transcript chunks retrieved per RAG query'),
  ('storage.audio_retention_days', 'null',             'Days to keep audio after processing (null = keep forever)'),
  ('auth.require_email_verification', 'false',         'Require email verification on registration')
ON CONFLICT (key) DO NOTHING;
