// PATCH /api/admin/users/[id]/status
// Body: { disabled: boolean }
//
// Disables (disabled: true) or re-enables (disabled: false) a user account via
// the Supabase Admin API ban_duration mechanism:
//   disable  → ban_duration = '876600h'  (~100 years = permanently banned)
//   enable   → ban_duration = 'none'     (removes the ban)
//
// A disabled user's tokens are rejected on use; they cannot log in until re-enabled.
//
// GUARDS:
//   - Cannot disable your own account.
//   - Cannot disable the last remaining admin.
//
// SECURITY: requires admin role on caller (server-side).

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/server'
import { guardDisable } from '@/lib/admin/guards'
import { logger } from '@/lib/logger'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let caller
  try {
    caller = await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  const { id: targetId } = await params

  let body: { disabled?: unknown }
  try {
    body = (await req.json()) as { disabled?: unknown }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  if (typeof body.disabled !== 'boolean') {
    return NextResponse.json({ error: 'disabled must be a boolean.' }, { status: 422 })
  }
  const shouldDisable = body.disabled

  const db = createServerClient()

  // Fetch target's role for last-admin guard
  const { data: targetProfile } = await db
    .from('profiles')
    .select('role')
    .eq('id', targetId)
    .maybeSingle()

  if (!targetProfile) {
    return NextResponse.json({ error: 'User not found.' }, { status: 404 })
  }

  // Count all admins (needed when disabling an admin)
  const { count: adminCount } = await db
    .from('profiles')
    .select('*', { count: 'exact', head: true })
    .eq('role', 'admin')

  // Only run the guard when disabling (enabling is always safe)
  if (shouldDisable) {
    const guard = guardDisable(caller.id, targetId, targetProfile.role, adminCount ?? 0)
    if (!guard.ok) {
      return NextResponse.json({ error: guard.message }, { status: guard.status })
    }
  }

  const banDuration = shouldDisable ? '876600h' : 'none'
  const { error: banErr } = await db.auth.admin.updateUserById(targetId, {
    ban_duration: banDuration,
  })

  if (banErr) {
    logger.error('[admin/status] updateUserById (ban_duration) failed', { detail: banErr.message })
    return NextResponse.json({ error: 'Failed to update account status.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, disabled: shouldDisable })
}
