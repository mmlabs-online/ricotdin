// GET /api/admin/usage
//
// Returns meeting and storage usage statistics for the admin dashboard.
// No transcript/notes/audio content is exposed — metadata only.
//
// SECURITY: requires admin role.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/server'
import { computeMeetingStats, computeStorageStats } from '@/lib/admin/usage'
import { logger } from '@/lib/logger'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  const db = createServerClient()

  // Fetch meeting metadata (status + created_at only)
  const { data: meetingRows, error: meetingsErr } = await db
    .from('meetings')
    .select('status, created_at')

  if (meetingsErr) {
    logger.error('[admin/usage] meetings query failed', { detail: meetingsErr.message })
    return NextResponse.json({ error: 'Failed to fetch meeting stats.' }, { status: 500 })
  }

  // Fetch storage file list
  const { data: storageFiles, error: storageErr } = await db
    .storage
    .from('recordings')
    .list('', { limit: 10000, offset: 0, sortBy: { column: 'created_at', order: 'asc' } })

  if (storageErr) {
    logger.error('[admin/usage] storage list failed', { detail: storageErr.message })
    // Non-fatal: return meeting stats with empty storage stats
  }

  const meetingStats  = computeMeetingStats(meetingRows ?? [])
  const storageStats  = computeStorageStats((storageFiles ?? []).map((f) => ({ metadata: f.metadata })))

  return NextResponse.json({ meetings: meetingStats, storage: storageStats })
}
