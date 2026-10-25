// SERVER ONLY — uses service-role client. Never import from client components.
//
// QUO-02 reconciliation sweep: finds meetings stuck in 'processing' that hold
// a quota reservation (gen:{id}:reserve) but have no settle or refund entry.
// These are orphaned by a server crash before the catch block could run.
//
// For each: issues a refund via applyQuotaMovement and marks the meeting failed.
//
// Scheduling: call reconcileStuckReservations() from:
//   • POST /api/admin/pipeline/reconcile-quota (manual admin trigger, MVP)
//   • An external cron hitting that route every ~5 minutes (recommended)
//   • instrumentation.ts + setInterval (deferred until REL-01 durable queue lands)

import { log, logger } from '@/lib/logger'
import { createServerClient } from '@/lib/supabase/server'
import { applyQuotaMovement } from './applyQuotaMovement'

/** Meetings stuck in processing longer than this are eligible for reconciliation. */
export const STUCK_TIMEOUT_MINUTES = 30

const RECLAIMED_MESSAGE =
  'QUOTA_BLOCKED: Reservation reclaimed — processing job was stuck in processing and exceeded the timeout.'

/**
 * Scan for meetings stuck in 'processing' past STUCK_TIMEOUT_MINUTES that hold
 * an unredeemed quota reservation, refund each one, and mark them failed.
 *
 * Idempotent: uses the same `gen:{id}:refund` dedup key as the pipeline's
 * catch block, so running the sweep twice for the same meeting is harmless.
 *
 * @returns Number of meetings reconciled in this run.
 */
export async function reconcileStuckReservations(): Promise<{ reconciled: number }> {
  const db = createServerClient()
  const cutoff = new Date(Date.now() - STUCK_TIMEOUT_MINUTES * 60 * 1000).toISOString()

  // Find all meetings stuck in processing beyond the timeout.
  const { data: stuckMeetings, error: fetchErr } = await db
    .from('meetings')
    .select('id, user_id')
    .eq('status', 'processing')
    .lt('updated_at', cutoff)

  if (fetchErr) {
    logger.error('[quota-reconcile] failed to fetch stuck meetings', { detail: fetchErr.message })
    return { reconciled: 0 }
  }

  if (!stuckMeetings || stuckMeetings.length === 0) {
    log('[quota-reconcile] no stuck meetings found')
    return { reconciled: 0 }
  }

  log(`[quota-reconcile] checking ${stuckMeetings.length} stuck meeting(s)`)
  let reconciled = 0

  for (const meeting of stuckMeetings) {
    try {
      // Check whether this meeting has a quota reservation.
      const { data: reserveEntry } = await db
        .from('quota_ledger')
        .select('delta_audio_seconds')
        .eq('dedup_key', `gen:${meeting.id}:reserve`)
        .maybeSingle()

      if (!reserveEntry) continue // no reservation — nothing to reclaim

      // Skip if already settled (transcription succeeded before the crash).
      const { data: settleEntry } = await db
        .from('quota_ledger')
        .select('id')
        .eq('dedup_key', `gen:${meeting.id}:settle`)
        .maybeSingle()

      if (settleEntry) continue // already settled; cost is final

      // Skip if already refunded (catch block ran before sweep, or sweep ran before).
      const { data: refundEntry } = await db
        .from('quota_ledger')
        .select('id')
        .eq('dedup_key', `gen:${meeting.id}:refund`)
        .maybeSingle()

      if (refundEntry) {
        // Refund already exists but meeting is still 'processing' — just mark failed.
        await db
          .from('meetings')
          .update({ status: 'failed', error_message: RECLAIMED_MESSAGE })
          .eq('id', meeting.id)
          .eq('status', 'processing')
        continue
      }

      // Issue refund. delta_audio_seconds is negative (e.g. -3600) so abs gives estimate.
      const estimateSecs = Math.abs(reserveEntry.delta_audio_seconds)

      if (estimateSecs > 0 && meeting.user_id) {
        await applyQuotaMovement({
          userId: meeting.user_id,
          deltaAudioSeconds: estimateSecs,
          deltaAgentQueries: 0,
          reason: 'refund',
          dedupKey: `gen:${meeting.id}:refund`,
          allowOverdraw: false,
          meetingId: meeting.id,
          metadata: {
            reason: 'stuck_reclaimed',
            stuck_timeout_minutes: STUCK_TIMEOUT_MINUTES,
          },
        })
      }

      // Mark meeting failed. The .eq('status', 'processing') guard prevents
      // overwriting a meeting that concurrently reached 'done' or 'failed'.
      const { error: updateErr } = await db
        .from('meetings')
        .update({ status: 'failed', error_message: RECLAIMED_MESSAGE })
        .eq('id', meeting.id)
        .eq('status', 'processing')

      if (updateErr) {
        logger.warn('[quota-reconcile] failed to mark meeting as failed', { meetingId: meeting.id, detail: updateErr.message })
      } else {
        log(`[quota-reconcile] reclaimed reservation for meeting ${meeting.id} (estimate=${estimateSecs}s)`)
        reconciled++
      }
    } catch (err) {
      logger.error('[quota-reconcile] error processing meeting', { meetingId: meeting.id, detail: String(err) })
      // Continue with remaining meetings — one failure shouldn't block the sweep.
    }
  }

  log(`[quota-reconcile] done — ${reconciled} meeting(s) reconciled`)
  return { reconciled }
}
