// PATCH /api/meetings/[id]/pin
//
// Toggles the meeting's pinned state:
//   - pinned_at IS NULL  →  set pinned_at = now()  (pin)
//   - pinned_at NOT NULL →  set pinned_at = NULL   (unpin)
//
// Returns { ok: true, pinned_at: string | null }.
//
// SECURITY: ownership verified server-side.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireUser } from '@/lib/auth/server'
import { logger } from '@/lib/logger'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let caller
  try {
    caller = await requireUser(req)
  } catch (res) {
    return res as NextResponse
  }

  const { id: meetingId } = await params
  const db = createServerClient()

  const { data: meeting, error: selectErr } = await db
    .from('meetings')
    .select('id, user_id, pinned_at')
    .eq('id', meetingId)
    .maybeSingle()

  if (selectErr) {
    logger.error('[meetings/pin] select failed', { detail: selectErr.message })
    return NextResponse.json({ error: 'Database error: ' + selectErr.message }, { status: 500 })
  }
  if (!meeting) return NextResponse.json({ error: 'Meeting not found.' }, { status: 404 })
  if (meeting.user_id !== caller.id) return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })

  const newPinnedAt = meeting.pinned_at ? null : new Date().toISOString()

  const { error: updateErr } = await db
    .from('meetings')
    .update({ pinned_at: newPinnedAt })
    .eq('id', meetingId)

  if (updateErr) {
    logger.error('[meetings/pin] update failed', { detail: updateErr.message })
    return NextResponse.json({ error: 'Failed to update pin status.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, pinned_at: newPinnedAt })
}
