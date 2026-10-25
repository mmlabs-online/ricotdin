// GET /api/admin/storage/orphans
//
// Returns a list of files in the `recordings` bucket that have no corresponding
// meeting row — i.e. files that can safely be deleted.
//
// SECURITY: requires admin role.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/server'
import { findOrphans } from '@/lib/admin/storage'
import { logger } from '@/lib/logger'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  const db = createServerClient()

  // All files in storage
  const { data: storageFiles, error: storageErr } = await db
    .storage
    .from('recordings')
    .list('', { limit: 10000, offset: 0 })

  if (storageErr) {
    logger.error('[admin/storage/orphans] storage list failed', { detail: storageErr.message })
    return NextResponse.json({ error: 'Failed to list storage files.' }, { status: 500 })
  }

  // All audio_path values in meetings (DB-tracked paths)
  const { data: meetings, error: meetingsErr } = await db
    .from('meetings')
    .select('audio_path')

  if (meetingsErr) {
    logger.error('[admin/storage/orphans] meetings query failed', { detail: meetingsErr.message })
    return NextResponse.json({ error: 'Failed to fetch meeting paths.' }, { status: 500 })
  }

  const storagePaths = new Set((storageFiles ?? []).map((f) => f.name))
  const dbPaths      = new Set(
    (meetings ?? [])
      .map((m) => m.audio_path)
      .filter(Boolean)
      .map((p) => (p as string).split('/').pop() ?? (p as string)),
  )

  const orphans = findOrphans(storagePaths, dbPaths)

  return NextResponse.json({ orphans, count: orphans.length })
}
