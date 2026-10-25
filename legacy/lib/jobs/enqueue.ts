// SERVER ONLY — uses SUPABASE_SERVICE_ROLE_KEY.
//
// Single entry point for adding a new pipeline job to the queue.
// Call this instead of processMeeting() at all three trigger sites:
//   - POST /api/meetings/:id/uploaded  (recording + file-upload flows)
//   - POST /api/meetings/:id/process   (manual re-trigger)
//   - POST /api/admin/pipeline/:id/requeue (admin re-run)

import { createServerClient } from '@/lib/supabase/server'
import { log } from '@/lib/logger'
import type { JobPayload } from './types'

/**
 * Insert a new job for the given meeting, starting at step='start'.
 * Throws on DB error — callers should handle and return 500.
 */
export async function enqueueJob(
  meetingId: string,
  payload: Partial<JobPayload> = {},
): Promise<void> {
  const db = createServerClient()
  const { error } = await db.from('jobs').insert({
    meeting_id: meetingId,
    step: 'start',
    status: 'queued',
    run_after: new Date().toISOString(),
    payload: payload as Record<string, unknown>,
  })
  if (error) throw new Error(`enqueueJob failed: ${error.message}`)
  log(`[jobs] enqueued job for meeting ${meetingId}`)
}
