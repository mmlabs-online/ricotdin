// PATCH /api/admin/users/[id]/role
// Body: { role: 'user' | 'admin' }
//
// Updates BOTH app_metadata.role (Auth Admin API, source of truth for JWT claims)
// AND profiles.role (display table) atomically in sequence.
// If the Auth update succeeds but the profiles sync fails, we log a warning —
// app_metadata is authoritative; profiles will be corrected on next role change.
//
// The new role takes effect on the target user's next token refresh.
//
// GUARDS (tested in tests/admin-guards.test.ts):
//   - Self-demotion: an admin cannot demote themselves.
//   - Last admin: cannot demote the last remaining admin.
//
// SECURITY: requires admin role on caller (server-side, not just UI).

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/server'
import { guardRoleDemotion } from '@/lib/admin/guards'
import { logger } from '@/lib/logger'
import type { UserRole } from '@/types/database'

const VALID_ROLES: UserRole[] = ['user', 'admin']

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

  let body: { role?: unknown }
  try {
    body = (await req.json()) as { role?: unknown }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  if (!body.role || !VALID_ROLES.includes(body.role as UserRole)) {
    return NextResponse.json(
      { error: `role must be one of: ${VALID_ROLES.join(', ')}.` },
      { status: 422 },
    )
  }
  const newRole = body.role as UserRole

  const db = createServerClient()

  // Fetch target's current role and admin count for guard evaluation
  const { data: targetProfile } = await db
    .from('profiles')
    .select('role')
    .eq('id', targetId)
    .maybeSingle()

  if (!targetProfile) {
    return NextResponse.json({ error: 'User not found.' }, { status: 404 })
  }

  // Count all admins (needed for last-admin guard on demotion)
  const { count: adminCount } = await db
    .from('profiles')
    .select('*', { count: 'exact', head: true })
    .eq('role', 'admin')

  const guard = guardRoleDemotion(
    caller.id,
    targetId,
    targetProfile.role,
    newRole,
    adminCount ?? 0,
  )
  if (!guard.ok) {
    return NextResponse.json({ error: guard.message }, { status: guard.status })
  }

  // Update app_metadata — this is the source of truth for JWT claims
  const { error: metaErr } = await db.auth.admin.updateUserById(targetId, {
    app_metadata: { role: newRole },
  })
  if (metaErr) {
    logger.error('[admin/role] updateUserById (app_metadata) failed', { detail: metaErr.message })
    return NextResponse.json({ error: 'Failed to update role.' }, { status: 500 })
  }

  // Sync profiles.role — non-fatal if this fails (app_metadata is authoritative)
  const { error: profileErr } = await db
    .from('profiles')
    .update({ role: newRole })
    .eq('id', targetId)

  if (profileErr) {
    logger.warn('[admin/role] profiles.role sync failed (app_metadata already updated)', { detail: profileErr.message })
  }

  return NextResponse.json({ ok: true, role: newRole })
}
