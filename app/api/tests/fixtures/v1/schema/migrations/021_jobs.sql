-- ============================================================================
-- Migration 021: Durable job queue for the meeting processing pipeline.
-- Implements REL-01 (survive restarts), REL-02 (stuck-job recovery),
-- REL-03 (idempotent retries).
--
-- jobs         — one row per pipeline run, stepped through start →
--                transcribe_poll → analyse → embed.
-- claim_next_job() — atomic FOR UPDATE SKIP LOCKED claim; safe under
--                    concurrency (multiple workers / PACELC safe).
--
-- Distinct from usage_log and audit_logs. This is the execution-control
-- table; the other two are observability only.
--
-- Apply in Supabase dashboard → SQL editor.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Table: jobs
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.jobs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id   uuid        NOT NULL
                             REFERENCES public.meetings(id) ON DELETE CASCADE,
  -- Which pipeline step this job is currently at.
  step         text        NOT NULL DEFAULT 'start'
                             CHECK (step IN (
                               'start',           -- download + transcode + Speechmatics submit
                               'transcribe_poll',  -- check Speechmatics status (check-once, re-schedule)
                               'analyse',          -- Gemini summary/notes/todos/calendar
                               'embed'             -- chunk + embed + mark done
                             )),
  status       text        NOT NULL DEFAULT 'queued'
                             CHECK (status IN ('queued', 'running', 'done', 'failed')),
  -- attempts counts how many times a step has FAILED. Not incremented for
  -- normal Speechmatics polling re-schedules (those are expected).
  attempts     int         NOT NULL DEFAULT 0,
  max_attempts int         NOT NULL DEFAULT 5,
  last_error   text        NULL,
  -- Backoff scheduling: worker only claims jobs where run_after <= now().
  run_after    timestamptz NOT NULL DEFAULT now(),
  -- Heartbeat / stuck detection.
  locked_at    timestamptz NULL,
  locked_by    text        NULL,    -- worker instance id (e.g. "worker-a3f2b1")
  -- Cross-restart durable state (speechmatics_job_id, quota flags, etc.).
  -- NEVER store meeting content (transcript/notes/summary) here.
  payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- auto-bump updated_at
CREATE OR REPLACE FUNCTION public.jobs_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS jobs_updated_at ON public.jobs;
CREATE TRIGGER jobs_updated_at
  BEFORE UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_set_updated_at();

-- ----------------------------------------------------------------------------
-- RLS
-- Users can read their own jobs (for status display); no user writes.
-- Admins can read all. All writes use the service-role client.
-- ----------------------------------------------------------------------------
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_jobs"
  ON public.jobs FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.meetings m
       WHERE m.id = jobs.meeting_id
         AND m.user_id = auth.uid()
    )
  );

CREATE POLICY "admin_read_all_jobs"
  ON public.jobs FOR SELECT TO authenticated
  USING (auth.jwt()->>'user_role' = 'admin');

-- No INSERT / UPDATE / DELETE policies — service-role only.

-- ----------------------------------------------------------------------------
-- Indexes
-- ----------------------------------------------------------------------------

-- Worker claim: queued jobs ordered by run_after ASC.
CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON public.jobs (run_after ASC) WHERE status = 'queued';

-- Stuck-job sweeper: running jobs ordered by locked_at ASC.
CREATE INDEX IF NOT EXISTS jobs_stuck_idx
  ON public.jobs (locked_at ASC) WHERE status = 'running';

-- Meeting-scoped lookup (requeue, admin views).
CREATE INDEX IF NOT EXISTS jobs_meeting_idx
  ON public.jobs (meeting_id);

-- ----------------------------------------------------------------------------
-- Function: claim_next_job
--
-- Atomically marks the next due queued job as 'running' and returns it.
-- FOR UPDATE SKIP LOCKED makes this safe under multiple concurrent workers
-- (each worker gets a different job; contention rows are skipped, not blocked).
--
-- SECURITY DEFINER so it bypasses RLS; callable only via the service-role
-- client from server-side TypeScript.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_next_job(p_worker_id text)
RETURNS SETOF public.jobs
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.jobs
  SET    status     = 'running',
         locked_at  = now(),
         locked_by  = p_worker_id,
         updated_at = now()
  WHERE  id = (
    SELECT id FROM public.jobs
    WHERE  status    = 'queued'
      AND  run_after <= now()
    ORDER  BY run_after ASC
    LIMIT  1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$;
