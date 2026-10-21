// POST /api/admin/pipeline/:id/requeue
//
// Re-trigger processing for any meeting regardless of current status.
//
// Safe re-run strategy:
//   1. Fetch the meeting (admin sees all — service role).
//   2. Delete all child rows that the pipeline inserts, so a second run
//      produces clean output with no duplicates:
//        transcript_segments → (transcript_chunks cascades automatically)
//        todos
//        calendar_suggestions
//   4. Reset meetings.status to 'pending' and clear error_message / summary /
//      notes / language so the UI shows a clean in-progress state.
//   5. Write an audit log entry.
//   6. Fire processMeeting() in the background (non-awaited).
//
// SECURITY: requires admin role (server-enforced via requireAdmin).

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/server'
import { enqueueJob } from '@/lib/jobs/enqueue'
import { writeAuditLog, requestContext } from '@/lib/admin/audit'
import { logger } from '@/lib/logger'
import { canReprocess } from '@/lib/retention/policy'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let actor
  try {
    actor = await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  const { id: meetingId } = await params

  if (!meetingId) {
    return NextResponse.json({ error: 'Missing meeting id.' }, { status: 400 })
  }

  const db = createServerClient()

  // Fetch the meeting — service role bypasses RLS, so any meeting is visible.
  const { data: meeting, error: fetchErr } = await db
    .from('meetings')
    .select('id, status, audio_path, user_id')
    .eq('id', meetingId)
    .maybeSingle()

  if (fetchErr) {
    logger.error('[admin/pipeline/requeue] fetch failed', { detail: fetchErr.message })
    return NextResponse.json({ error: 'Failed to fetch meeting.' }, { status: 500 })
  }

  if (!meeting) {
    return NextResponse.json({ error: 'Meeting not found.' }, { status: 404 })
  }

  // PRV-02: without audio a re-run would wipe the transcript below and then fail.
  if (!canReprocess(meeting)) {
    return NextResponse.json(
      { error: 'This meeting has no audio (deleted by the retention policy), so it cannot be reprocessed.' },
      { status: 409 },
    )
  }

  // ── Clear child rows so the pipeline re-runs cleanly ──────────────────────
  // transcript_chunks FKs to meeting_id directly (not via transcript_segments),
  // so it must be deleted explicitly — it does NOT cascade when segments are removed.

  const childDeletes = await Promise.allSettled([
    db.from('transcript_chunks').delete().eq('meeting_id', meetingId),
    db.from('transcript_segments').delete().eq('meeting_id', meetingId),
    db.from('todos').delete().eq('meeting_id', meetingId),
    db.from('calendar_suggestions').delete().eq('meeting_id', meetingId),
  ])

  for (const result of childDeletes) {
    if (result.status === 'rejected') {
      logger.error('[admin/pipeline/requeue] child delete failed', { detail: String(result.reason) })
      return NextResponse.json(
        { error: 'Failed to clear prior pipeline output. Requeue aborted.' },
        { status: 500 },
      )
    }
    const { error } = result.value
    if (error) {
      logger.error('[admin/pipeline/requeue] child delete error', { detail: error.message })
      return NextResponse.json(
        { error: 'Failed to clear prior pipeline output. Requeue aborted.' },
        { status: 500 },
      )
    }
  }

  // ── Reset meeting status to 'pending' ─────────────────────────────────────
  const { error: resetErr } = await db
    .from('meetings')
    .update({
      status: 'pending',
      error_message: null,
      summary: null,
      notes: null,
      language: null,
    })
    .eq('id', meetingId)

  if (resetErr) {
    logger.error('[admin/pipeline/requeue] status reset failed', { detail: resetErr.message })
    return NextResponse.json({ error: 'Failed to reset meeting status.' }, { status: 500 })
  }

  // ── Audit log ─────────────────────────────────────────────────────────────
  const { ipAddress, userAgent } = requestContext(req)
  void writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email ?? '',
    action: 'meeting.requeue',
    targetType: 'meeting',
    targetId: meetingId,
    metadata: {
      previous_status: meeting.status,
      meeting_owner_id: meeting.user_id,
    },
    ipAddress,
    userAgent,
  })

  // ── Enqueue a durable job (REL-01/02/03) ─────────────────────────────────
  // The worker picks it up, claiming the meeting atomically from 'pending'.
  await enqueueJob(meetingId)

  return NextResponse.json({ ok: true, meetingId })
}
