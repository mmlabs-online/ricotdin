// GET /api/admin/pipeline/overview
//
// Returns aggregate pipeline metrics across ALL meetings (service role, no RLS).
// Privacy: counts, timings, and error snippets only — no transcript/audio content.
//
// SECURITY: requires admin role (server-enforced via requireAdmin).

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/server'
import { logger } from '@/lib/logger'

const STUCK_THRESHOLD_MINUTES = 15

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  const db = createServerClient()

  // Fetch only the columns needed for stats — no transcript/notes content.
  const { data: rows, error } = await db
    .from('meetings')
    .select('status, created_at, updated_at')

  if (error) {
    logger.error('[admin/pipeline/overview] fetch failed', { detail: error.message })
    return NextResponse.json({ error: 'Failed to fetch pipeline stats.' }, { status: 500 })
  }

  const now = Date.now()
  const stuckCutoff = now - STUCK_THRESHOLD_MINUTES * 60 * 1000

  let pending = 0
  let processing = 0
  let done = 0
  let failed = 0
  let stuck = 0
  const doneProcessingSecs: number[] = []

  for (const row of rows ?? []) {
    switch (row.status) {
      case 'pending':    pending++;    break
      case 'processing': processing++; break
      case 'done':       done++;       break
      case 'failed':     failed++;     break
    }

    if (
      row.status === 'processing' &&
      new Date(row.updated_at).getTime() < stuckCutoff
    ) {
      stuck++
    }

    if (row.status === 'done' && row.created_at && row.updated_at) {
      const secs =
        (new Date(row.updated_at).getTime() - new Date(row.created_at).getTime()) / 1000
      if (secs > 0) doneProcessingSecs.push(secs)
    }
  }

  const avg_processing_secs =
    doneProcessingSecs.length > 0
      ? Math.round(doneProcessingSecs.reduce((a, b) => a + b, 0) / doneProcessingSecs.length)
      : null

  return NextResponse.json({
    counts: { pending, processing, done, failed, stuck },
    avg_processing_secs,
    stuck_threshold_minutes: STUCK_THRESHOLD_MINUTES,
    total: (rows ?? []).length,
  })
}
