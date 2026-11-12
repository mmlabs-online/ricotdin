// DELETE /api/admin/users/[id]
//
// Permanently deletes a user. Steps:
//   1. Verify caller is admin.
//   2. Self-delete and last-admin guards.
//   3. Collect audio_path values from all of the target's meetings.
//   4. Delete those Storage objects (service role). Failures are logged +
//      returned as warnings; they do NOT abort the user delete.
//   5. auth.admin.deleteUser() — CASCADE on auth.users removes profiles and
//      meetings (and all their children: transcript_segments, transcript_chunks,
//      todos, calendar_suggestions, chat_sessions, chat_messages).
//
// GUARDS:
//   - Cannot delete your own account.
//   - Cannot delete the last remaining admin.
//
// SECURITY: requires admin role on caller (server-side).
// SECURITY: service role key stays server-only.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/server'
import { guardDelete } from '@/lib/admin/guards'
import { deriveUserStatus } from '@/lib/admin/userStatus'
import { deleteObjects } from '@/lib/storage'
import { isOwnedAudioKey } from '@/lib/retention/policy'
import { logger } from '@/lib/logger'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  const { id: targetId } = await params
  const db = createServerClient()

  const { data: { user: authUser }, error: userErr } = await db.auth.admin.getUserById(targetId)
  if (userErr || !authUser) {
    return NextResponse.json({ error: 'User not found.' }, { status: 404 })
  }

  const { data: profile } = await db
    .from('profiles')
    .select('username, role')
    .eq('id', targetId)
    .maybeSingle()

  const { count: meetingCount } = await db
    .from('meetings')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', targetId)

  const appRole = (authUser.app_metadata as Record<string, unknown>)?.role as string | undefined

  return NextResponse.json({
    id: authUser.id,
    email: authUser.email ?? null,
    username: profile?.username ?? null,
    role: (appRole ?? profile?.role ?? 'user') as 'user' | 'admin',
    disabled: !!authUser.banned_until && new Date(authUser.banned_until) > new Date(),
    status: deriveUserStatus({ bannedUntil: authUser.banned_until, emailConfirmedAt: authUser.email_confirmed_at }),
    meeting_count: meetingCount ?? 0,
    created_at: authUser.created_at,
    last_sign_in_at: authUser.last_sign_in_at ?? null,
  })
}

export async function DELETE(
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
  const db = createServerClient()

  // Fetch target role for guard evaluation
  const { data: targetProfile } = await db
    .from('profiles')
    .select('role')
    .eq('id', targetId)
    .maybeSingle()

  if (!targetProfile) {
    return NextResponse.json({ error: 'User not found.' }, { status: 404 })
  }

  // Count all admins for last-admin guard
  const { count: adminCount } = await db
    .from('profiles')
    .select('*', { count: 'exact', head: true })
    .eq('role', 'admin')

  const guard = guardDelete(caller.id, targetId, targetProfile.role, adminCount ?? 0)
  if (!guard.ok) {
    return NextResponse.json({ error: guard.message }, { status: guard.status })
  }

  // Collect audio paths + providers from all of the target's meetings before deleting
  const { data: meetings } = await db
    .from('meetings')
    .select('id, user_id, audio_path, storage_provider')
    .eq('user_id', targetId)

  // audio_path is user-editable under RLS: only delete each meeting's own object, so a
  // forged path can't make this delete another user's audio.
  const audioItems = (meetings ?? [])
    .filter((m) => typeof m.audio_path === 'string' && isOwnedAudioKey(m.audio_path, m.user_id, m.id))
    .map((m) => ({ key: m.audio_path as string, provider: m.storage_provider }))

  // Delete storage objects (handles mixed supabase/r2 providers). Failures are non-fatal.
  const storageWarnings: string[] = []
  if (audioItems.length > 0) {
    const failed = await deleteObjects(audioItems)
    if (failed.length > 0) {
      const msg = `Audio storage cleanup failed for ${failed.length} file(s): ${failed.join(', ')}`
      logger.warn('[admin/delete] ' + msg)
      storageWarnings.push(msg)
    }
  }

  // Delete the user — CASCADE handles profiles, meetings, and all child rows
  const { error: deleteErr } = await db.auth.admin.deleteUser(targetId)
  if (deleteErr) {
    logger.error('[admin/delete] deleteUser failed', { detail: deleteErr.message })
    return NextResponse.json({ error: 'Failed to delete user.' }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    deleted: targetId,
    ...(storageWarnings.length > 0 ? { storageWarnings } : {}),
  })
}
