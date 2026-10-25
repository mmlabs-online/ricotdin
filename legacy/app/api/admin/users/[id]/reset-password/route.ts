// POST /api/admin/users/[id]/reset-password
//
// Triggers a password-recovery email for the target user via Supabase's
// auth.admin.generateLink({ type: 'recovery', email }). The email is sent
// through the project's configured SMTP provider (Supabase built-in or custom).
//
// Does NOT set a new password directly — the user receives a one-time link and
// chooses their own password. Do not call auth.admin.updateUserById({ password })
// here; that would silently replace the password without the user's consent.
//
// Note: email delivery requires SMTP to be configured in the Supabase project
// (Authentication → SMTP Settings). If SMTP is not configured the link is still
// generated (returned in data) but no email is sent.
//
// SECURITY: requires admin role on caller (server-side).

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/server'
import { logger } from '@/lib/logger'

export async function POST(
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

  // Look up the target user's email — generateLink needs it, not the ID
  const { data: { user: targetUser }, error: getUserErr } = await db.auth.admin.getUserById(targetId)
  if (getUserErr || !targetUser) {
    return NextResponse.json({ error: 'User not found.' }, { status: 404 })
  }
  if (!targetUser.email) {
    return NextResponse.json(
      { error: 'User has no email address — cannot send password reset.' },
      { status: 422 },
    )
  }

  // Generate a recovery link, which also triggers the recovery email
  const { error: linkErr } = await db.auth.admin.generateLink({
    type: 'recovery',
    email: targetUser.email,
  })

  if (linkErr) {
    logger.error('[admin/reset-password] generateLink failed', { detail: linkErr.message })
    return NextResponse.json({ error: 'Failed to send password reset email.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
