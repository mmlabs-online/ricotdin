// POST /api/admin/storage/cleanup
// Body: { paths: string[] }
//
// Deletes the supplied list of storage paths from the `recordings` bucket.
// Designed to receive the array returned by GET /api/admin/storage/orphans.
// Max 500 paths per call; batched internally at 100 per Supabase remove() call.
//
// SECURITY: requires admin role.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/server'
import { batchPaths } from '@/lib/admin/storage'
import { writeAuditLog, requestContext } from '@/lib/admin/audit'
import { logger } from '@/lib/logger'

export async function POST(req: NextRequest) {
  let caller
  try {
    caller = await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const b = body as Record<string, unknown>
  if (!Array.isArray(b.paths) || b.paths.length === 0) {
    return NextResponse.json({ error: 'paths must be a non-empty array.' }, { status: 422 })
  }
  if (b.paths.length > 500) {
    return NextResponse.json({ error: 'Maximum 500 paths per cleanup request.' }, { status: 422 })
  }

  const paths = b.paths as string[]
  const db = createServerClient()
  const batches = batchPaths(paths, 100)

  let deleted = 0
  const errors: string[] = []

  for (const batch of batches) {
    const { error } = await db.storage.from('recordings').remove(batch)
    if (error) {
      logger.error('[admin/storage/cleanup] remove batch failed', { detail: error.message })
      errors.push(error.message)
    } else {
      deleted += batch.length
    }
  }

  const { ipAddress, userAgent } = requestContext(req)
  void writeAuditLog({
    actorId:    caller.id,
    actorEmail: caller.email ?? '',
    action:     'storage.cleanup',
    targetType: 'storage',
    targetId:   'recordings',
    metadata:   { deletedCount: deleted, requestedCount: paths.length },
    ipAddress,
    userAgent,
  })

  return NextResponse.json({ deleted, errors: errors.length ? errors : undefined })
}
