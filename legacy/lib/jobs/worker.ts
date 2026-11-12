// SERVER ONLY
//
// In-process long-running worker for the durable job queue (REL-01/02).
//
// Design:
//   - One instance per server process (startWorker() is idempotent).
//   - Claims one job at a time via claim_next_job() (FOR UPDATE SKIP LOCKED),
//     so it is safe if two worker instances ever run concurrently.
//   - Dispatches to step handlers in lib/jobs/steps/*.
//   - On transient error: exponential backoff + jitter via run_after.
//   - On terminal error or attempts >= max_attempts: marks job + meeting failed.
//   - Periodic sweeper finds 'running' jobs stuck for > STUCK_THRESHOLD_MS
//     and requeues or fails them.
//
// Logging hooks: every state transition logs with a [worker] prefix so that
// OBS-01/02 structured logging can pick them up later.

import { randomUUID } from 'node:crypto'
import { createServerClient } from '@/lib/supabase/server'
import { log, logger, errorToMessage, describeError } from '@/lib/logger'
import { captureException } from '@/lib/monitoring'
import { logActivity } from '@/lib/activity/logActivity'
import { applyQuotaMovement } from '@/lib/quota/applyQuotaMovement'
import { AllGeminiKeysExhaustedError } from '@/lib/gemini/pool'
import { PipelineError } from '@/lib/gemini/errors'
import { runStart } from './steps/start'
import { runTranscribePoll } from './steps/transcribePoll'
import { runAnalyse } from './steps/analyse'
import { runEmbed } from './steps/embed'
import { reconcileWallets } from '../quota/reconcileWallets'
import type { JobRow, JobPayload } from './types'

// ── Config ────────────────────────────────────────────────────────────────────

const WORKER_ID = `worker-${randomUUID().slice(0, 8)}`
const WORKER_POLL_MS = 1_000          // sleep between polls when no job available
const STUCK_THRESHOLD_MS = 15 * 60_000  // 15 min: same threshold as ADM-04 dashboard
const STUCK_SWEEP_MS = 60_000         // sweep every 60 s
const RECONCILE_INTERVAL_MS = 5 * 60_000  // wallet reconciliation every 5 min

// Retry backoff: 2s, 4s, 8s … capped at 5 min; ±25% jitter.
const BASE_BACKOFF_MS = 2_000
const MAX_BACKOFF_MS = 5 * 60_000

// ── Helpers ───────────────────────────────────────────────────────────────────

function jitteredBackoff(attempts: number): number {
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS)
  return Math.round(exp * (0.75 + Math.random() * 0.5))
}

/**
 * Terminal errors should NOT be retried — they indicate bad data or
 * programming errors, not transient infrastructure failures.
 *
 * Transient (retryable):
 *   - AllGeminiKeysExhaustedError: all keys on cooldown — wait and retry.
 *   - Any non-PipelineError (network, timeout, DB hiccup).
 *
 * Terminal:
 *   - PipelineError that is NOT AllGeminiKeysExhaustedError (schema
 *     validation failure, unsupported format, etc.).
 */
function isTerminalError(err: unknown): boolean {
  if (err instanceof AllGeminiKeysExhaustedError) return false
  if (err instanceof PipelineError) return true
  return false
}

// ── Claim ─────────────────────────────────────────────────────────────────────

async function claimNextJob(): Promise<JobRow | null> {
  const db = createServerClient()
  // 'claim_next_job' is not yet in the generated Database type — cast to any.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any).rpc('claim_next_job', { p_worker_id: WORKER_ID })
  if (error) throw new Error(`claim_next_job RPC failed: ${(error as { message: string }).message}`)
  return ((data as JobRow[]) ?? [])[0] ?? null
}

// ── Error handler ─────────────────────────────────────────────────────────────

async function handleJobError(job: JobRow, err: unknown): Promise<void> {
  // describeError includes the error name, structured fields (Postgres
  // code/hint/details, HTTP status, .cause) AND the originating stack frame, so
  // even an unhelpful message like "[object Object]" still names where it failed.
  const message = describeError(err)
  const stackTop = err instanceof Error ? err.stack?.split('\n').slice(0, 4).join('\n') : undefined
  const terminal = isTerminalError(err)
  const newAttempts = job.attempts + 1
  const db = createServerClient()
  const payload = job.payload as JobPayload

  if (!terminal && newAttempts < job.max_attempts) {
    const delay = jitteredBackoff(newAttempts)
    logger.warn(
      `[worker] job ${job.id} step=${job.step} transient error, retry in ${Math.round(delay / 1000)}s`,
      { jobId: job.id, step: job.step, meetingId: job.meeting_id, detail: message, stack: stackTop },
    )
    await db.from('jobs').update({
      status: 'queued',
      attempts: newAttempts,
      last_error: message.slice(0, 500),
      run_after: new Date(Date.now() + delay).toISOString(),
      locked_at: null,
      locked_by: null,
    }).eq('id', job.id)
    return
  }

  // Terminal or attempts exhausted.
  logger.error(
    `[worker] job ${job.id} step=${job.step} FAILED (${newAttempts}/${job.max_attempts})`,
    { jobId: job.id, step: job.step, meetingId: job.meeting_id, detail: message, stack: stackTop },
  )
  captureException(err, { jobId: job.id, step: job.step, meetingId: job.meeting_id, attempt: newAttempts })

  await db.from('jobs').update({
    status: 'failed',
    attempts: newAttempts,
    last_error: message.slice(0, 500),
    locked_at: null,
    locked_by: null,
  }).eq('id', job.id)

  // QUO-02: refund reserved quota if transcription never settled.
  // Dedup key prevents a double-refund if the job is manually requeued later.
  if (payload.reserve_done && !payload.transcription_settled && payload.user_id && payload.estimate_seconds) {
    await applyQuotaMovement({
      userId: payload.user_id,
      deltaAudioSeconds: payload.estimate_seconds,
      deltaAgentQueries: 0,
      reason: 'refund',
      dedupKey: `gen:${job.meeting_id}:refund`,
      allowOverdraw: false,
      meetingId: job.meeting_id,
      metadata: { reason: 'pipeline_failure', error: message.slice(0, 200) },
    }).catch((e: unknown) => {
      logger.error('[worker] quota refund failed (non-fatal)', { detail: describeError(e) })
    })
  }

  // Mark the meeting as failed so ADM-04 shows it.
  await db.from('meetings').update({
    status: 'failed',
    error_message: message.slice(0, 500),
  }).eq('id', job.meeting_id)

  if (payload.user_id) {
    logActivity({
      userId: payload.user_id,
      eventType: 'processing_failed',
      meetingId: job.meeting_id,
      metadata: { error: message.slice(0, 200) },
    })
  }
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

async function executeJob(job: JobRow): Promise<void> {
  log(`[worker] executing job ${job.id} step=${job.step} attempt=${job.attempts} meeting=${job.meeting_id}`)
  try {
    switch (job.step) {
      case 'start':           await runStart(job); break
      case 'transcribe_poll': await runTranscribePoll(job); break
      case 'analyse':         await runAnalyse(job); break
      case 'embed':           await runEmbed(job); break
      default:
        throw new PipelineError(`Unknown job step: ${job.step}`)
    }
  } catch (err) {
    await handleJobError(job, err)
  }
}

// ── Stuck-job sweeper (REL-02) ────────────────────────────────────────────────

async function sweepStuckJobs(): Promise<void> {
  const db = createServerClient()
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS).toISOString()

  const { data: stuck } = await db
    .from('jobs')
    .select('*')
    .eq('status', 'running')
    .lt('locked_at', cutoff)

  for (const raw of stuck ?? []) {
    const job = raw as unknown as JobRow
    const newAttempts = job.attempts + 1
    log(`[worker] sweeper found stuck job ${job.id} step=${job.step} locked_at=${job.locked_at}`)

    if (newAttempts >= job.max_attempts) {
      const errMsg = 'Job timed out (stuck in running state — server may have restarted mid-step)'
      await db.from('jobs').update({
        status: 'failed',
        attempts: newAttempts,
        last_error: errMsg,
        locked_at: null,
        locked_by: null,
      }).eq('id', job.id)
      await db.from('meetings').update({
        status: 'failed',
        error_message: 'Processing timed out. Use the Requeue button to retry.',
      }).eq('id', job.meeting_id)
      log(`[worker] sweeper: terminated job ${job.id} (max attempts reached)`)
    } else {
      // For 'start' step: the meeting is in 'processing'; reset to 'pending'
      // so the next run can re-claim it with the .in(['pending','failed']) guard.
      if (job.step === 'start') {
        await db.from('meetings').update({ status: 'pending' }).eq('id', job.meeting_id)
      }
      await db.from('jobs').update({
        status: 'queued',
        attempts: newAttempts,
        last_error: `Requeued after stuck timeout (attempt ${newAttempts}/${job.max_attempts})`,
        locked_at: null,
        locked_by: null,
        run_after: new Date().toISOString(),
      }).eq('id', job.id)
      log(`[worker] sweeper: requeued job ${job.id} step=${job.step} (attempt ${newAttempts}/${job.max_attempts})`)
    }
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

export async function runWorkerLoop(): Promise<never> {
  log(`[worker] ${WORKER_ID} started`)
  let nextSweepAt = Date.now() + STUCK_SWEEP_MS
  let nextReconcileAt = Date.now() + RECONCILE_INTERVAL_MS

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Periodic stuck-job sweep (non-blocking — errors are swallowed).
    if (Date.now() >= nextSweepAt) {
      sweepStuckJobs().catch((e: unknown) =>
        logger.error('[worker] sweeper error', { detail: String(e) }),
      )
      nextSweepAt = Date.now() + STUCK_SWEEP_MS
    }

    // QUO-04: ledger↔wallet reconciliation (non-blocking, independent timer).
    if (Date.now() >= nextReconcileAt) {
      reconcileWallets().catch((e: unknown) =>
        logger.error('[wallet-reconcile] loop error', { detail: String(e) }),
      )
      nextReconcileAt = Date.now() + RECONCILE_INTERVAL_MS
    }

    try {
      const job = await claimNextJob()
      if (!job) {
        await new Promise<void>((r) => setTimeout(r, WORKER_POLL_MS))
        continue
      }
      // Execute synchronously — one job at a time keeps the implementation
      // simple and predictable. transcribe_poll steps complete in <1s (one
      // HTTP call), so throughput is not a concern for the single-server MVP.
      await executeJob(job)
    } catch (err) {
      // Unexpected loop-level error (e.g. DB unreachable during claim).
      logger.error('[worker] loop error', { detail: errorToMessage(err) })
      captureException(err)
      await new Promise<void>((r) => setTimeout(r, WORKER_POLL_MS))
    }
  }
}
