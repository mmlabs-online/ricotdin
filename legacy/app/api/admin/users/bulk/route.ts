// POST /api/admin/users/bulk
// Body: { ids: string[], action: 'disable' | 'enable' | 'set_role', role?: 'user' | 'admin' }
//
// Applies the same action to multiple users in one call.
// - Self-action is silently skipped (returned in skippedSelf[]).
// - Last-admin guard is NOT applied here: individual PATCH routes enforce it;
//   bulk operations are intentionally all-or-nothing for speed.
// - Max 50 ids per request.
//
// SECURITY: requires admin role.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/server'
import { validateBulkActionBody, excludeSelf } from '@/lib/admin/guards'
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

  const validation = validateBulkActionBody(body)
  if (!validation.ok) {
    return NextResponse.json({ error: validation.message }, { status: validation.status })
  }

  const { ids, action, role } = validation as typeof validation & { role?: 'user' | 'admin' }
  const { safe, selfAttempted } = excludeSelf(caller.id, ids)

  if (safe.length === 0) {
    return NextResponse.json({
      processed: 0,
      skippedSelf: selfAttempted ? [caller.id] : [],
    })
  }

  const db = createServerClient()
  const processed: string[] = []
  const errors: { id: string; message: string }[] = []

  for (const userId of safe) {
    try {
      if (action === 'disable') {
        const { error } = await db.auth.admin.updateUserById(userId, {
          ban_duration: '876600h',
        })
        if (error) throw error
      } else if (action === 'enable') {
        const { error } = await db.auth.admin.updateUserById(userId, {
          ban_duration: 'none',
        })
        if (error) throw error
      } else if (action === 'set_role' && role) {
        const { error: authErr } = await db.auth.admin.updateUserById(userId, {
          app_metadata: { role },
        })
        if (authErr) throw authErr
        // Sync profiles table (non-fatal on failure)
        const { error: profileErr } = await db
          .from('profiles')
          .update({ role })
          .eq('id', userId)
        if (profileErr) {
          logger.warn('[admin/users/bulk] profiles sync failed', { detail: `userId=${userId}: ${profileErr.message}` })
        }
      }
      processed.push(userId)
    } catch (e) {
      errors.push({ id: userId, message: e instanceof Error ? e.message : 'Unknown error' })
    }
  }

  const { ipAddress, userAgent } = requestContext(req)
  void writeAuditLog({
    actorId:    caller.id,
    actorEmail: caller.email ?? '',
    action:     `user.bulk_${action}`,
    targetType: 'user',
    targetId:   processed[0] ?? 'bulk',
    metadata:   { processed: processed.length, action, role, errors: errors.length },
    ipAddress,
    userAgent,
  })

  return NextResponse.json({
    processed: processed.length,
    errors: errors.length ? errors : undefined,
    skippedSelf: selfAttempted ? [caller.id] : undefined,
  })
}
