// Types for the durable job queue (REL-01/02/03).
// Mirrors the public.jobs table in migrations/021_jobs.sql.

export type JobStep = 'start' | 'transcribe_poll' | 'analyse' | 'embed'
export type JobStatus = 'queued' | 'running' | 'done' | 'failed'

export interface JobRow {
  id: string
  meeting_id: string
  step: JobStep
  status: JobStatus
  attempts: number
  max_attempts: number
  last_error: string | null
  run_after: string
  locked_at: string | null
  locked_by: string | null
  payload: JobPayload
  created_at: string
  updated_at: string
}

/**
 * Durable state persisted between worker restarts.
 * All fields optional — only populated as the pipeline advances.
 * NEVER store meeting content (transcript, notes, summary) here.
 */
export interface JobPayload {
  /** Speechmatics Batch API job id — set after submission in 'start'. */
  speechmatics_job_id?: string
  /** Meeting owner — copied from meetings.user_id in 'start' for later steps. */
  user_id?: string | null
  /** Estimated audio seconds from ffprobe, used for quota reserve and refund. */
  estimate_seconds?: number
  /** True once the quota reserve (gen:id:reserve) has been applied. */
  reserve_done?: boolean
  /** True once the quota settle (gen:id:settle) has been applied. */
  transcription_settled?: boolean
  /** True when the Speechmatics job was resubmitted with language='en' after auto-detect failure. */
  lang_retry?: boolean
  /** Optional speaker count hint passed through to Speechmatics. */
  speaker_count?: number
  /** Index into the in-memory SpeechmaticsKeyPool for the key holding this job. */
  speechmatics_key_index?: number
  /** AIP-06: optional model pick from the record/upload UI. Consumed by the start step. */
  preferred_provider?: string
  preferred_model?: string
}
