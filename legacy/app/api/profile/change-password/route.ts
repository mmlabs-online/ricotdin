// POST /api/profile/change-password
//
// Self-service password change.
// Requires the user to prove knowledge of their current password before updating.
// Flow:
//   1. requireUser — verify JWT, get user email.
//   2. Re-authenticate with signInWithPassword(email, currentPassword).
//   3. Validate newPassword with the same rules as sign-up.
//   4. Call auth.updateUser({ password: newPassword }) with the user's session.
//
// The Supabase Admin API is NOT used here so we can't bypass the re-auth step.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireUser } from '@/lib/auth/server'
import { validatePassword } from '@/lib/auth/validate'
import { logger } from '@/lib/logger'
import type { Database } from '@/types/database'

export async function POST(req: NextRequest) {
  let user
  try {
    user = await requireUser(req)
  } catch (res) {
    return res as NextResponse
  }

  const email = user.email
  if (!email) {
    return NextResponse.json({ error: 'Account has no email address.' }, { status: 400 })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const { currentPassword, newPassword } = body

  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return NextResponse.json(
      { error: 'currentPassword and newPassword are required strings.' },
      { status: 400 },
    )
  }

  // Validate new password strength (same rules as sign-up)
  const pwErr = validatePassword(newPassword)
  if (pwErr) return NextResponse.json({ error: pwErr }, { status: 422 })

  if (newPassword === currentPassword) {
    return NextResponse.json(
      { error: 'New password must be different from the current password.' },
      { status: 422 },
    )
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

  // Step 1: Re-authenticate to verify current password.
  // signInWithPassword stores the resulting session in the client's memory even
  // with persistSession:false, so we can call updateUser on the same client.
  const authClient = createClient<Database>(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error: signInErr } = await authClient.auth.signInWithPassword({
    email,
    password: currentPassword,
  })
  if (signInErr) {
    return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 401 })
  }

  // Step 2: Update password — reuse the same client (session is in memory from step 1).
  // A second client with global.headers.Authorization does NOT work: the Auth SDK
  // reads from its internal session state, not from HTTP headers.
  const { error: updateErr } = await authClient.auth.updateUser({ password: newPassword })
  if (updateErr) {
    logger.error('[POST /api/profile/change-password] updateUser failed', { detail: updateErr.message })
    return NextResponse.json({ error: 'Failed to update password.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
