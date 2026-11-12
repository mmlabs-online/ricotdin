// POST /api/auth/register
//
// Creates a new user account:
//   1. Validates email, username, password.
//   2. Checks username uniqueness (server-side, via service role).
//   3. Creates the auth.users row via admin API — sets app_metadata.role='user',
//      email_confirm=false (the user must verify their email before sign-in).
//   4. Inserts a public.profiles row.
//   5. Sends the email-verification link (anon client `auth.resend`). The user
//      can sign in immediately after clicking the link — no admin approval.
//
// SECURITY: role is always forced to 'user'. The client cannot influence it.
// SECURITY: service role key stays server-only (never returned to client).
//
// NOTE: sending the verification email requires SMTP configured in the Supabase
// project (Dashboard → Authentication → Emails / SMTP). Without it, no mail goes out.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@/lib/supabase/server'
import {
  normalizeUsername,
  validateUsername,
  validateEmail,
  validatePassword,
} from '@/lib/auth/validate'
import { logger } from '@/lib/logger'
import { applyQuotaMovement } from '@/lib/quota/applyQuotaMovement'
import type { Database } from '@/types/database'

const SIGNUP_AUDIO_SECONDS = 60 * 60   // 60 minutes
const SIGNUP_AGENT_QUERIES = 50

export async function POST(req: NextRequest) {
  let body: { email?: string; username?: string; password?: string }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const { email: rawEmail = '', username: rawUsername = '', password = '' } = body

  // ── Validate inputs ────────────────────────────────────────────────────────
  const emailErr = validateEmail(rawEmail.trim())
  if (emailErr) return NextResponse.json({ error: emailErr }, { status: 422 })

  const username = normalizeUsername(rawUsername)
  const usernameErr = validateUsername(username)
  if (usernameErr) return NextResponse.json({ error: usernameErr }, { status: 422 })

  const passwordErr = validatePassword(password)
  if (passwordErr) return NextResponse.json({ error: passwordErr }, { status: 422 })

  const email = rawEmail.trim().toLowerCase()

  // ── Check username uniqueness ──────────────────────────────────────────────
  const db = createServerClient()
  const { data: existing } = await db
    .from('profiles')
    .select('id')
    .eq('username', username)
    .maybeSingle()

  if (existing) {
    return NextResponse.json(
      { error: 'That username is already taken. Please choose another.' },
      { status: 409 },
    )
  }

  // ── Create the auth user (email_confirm=false → verification required) ───────
  const { data: adminData, error: createErr } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: false,            // user must verify their email before sign-in
    app_metadata: { role: 'user' },  // ONLY place role is set; never user_metadata
  })

  if (createErr || !adminData.user) {
    // Supabase returns "User already registered" for duplicate emails
    const msg = createErr?.message ?? ''
    if (msg.toLowerCase().includes('already')) {
      return NextResponse.json(
        { error: 'An account with that email already exists.' },
        { status: 409 },
      )
    }
    logger.error('[register] createUser failed', { detail: msg })
    return NextResponse.json({ error: 'Failed to create account.' }, { status: 500 })
  }

  const userId = adminData.user.id

  // ── Insert profile row ─────────────────────────────────────────────────────
  const { error: profileErr } = await db
    .from('profiles')
    .insert({ id: userId, username, role: 'user' })

  if (profileErr) {
    // Cleanup: delete the auth user so we don't leave an orphan
    await db.auth.admin.deleteUser(userId)
    logger.error('[register] profile insert failed', { detail: profileErr.message })
    return NextResponse.json(
      { error: 'Failed to create user profile. Please try again.' },
      { status: 500 },
    )
  }

  // ── Grant initial quota ────────────────────────────────────────────────────
  // Non-fatal: a quota failure must not block account creation.
  try {
    await applyQuotaMovement({
      userId,
      deltaAudioSeconds: SIGNUP_AUDIO_SECONDS,
      deltaAgentQueries: SIGNUP_AGENT_QUERIES,
      reason: 'admin_grant',
      dedupKey: `signup:${userId}`,
      allowOverdraw: true,
      metadata: { source: 'signup_initial_grant' },
    })
  } catch (err) {
    logger.error('[register] initial quota grant failed', { userId, detail: String(err) })
  }

  // ── Send the email-verification link ───────────────────────────────────────
  // admin.createUser never sends mail itself, so trigger the signup confirmation
  // explicitly via the anon client. Requires SMTP configured in the Supabase project.
  const origin = req.headers.get('origin') ?? req.nextUrl.origin
  const anon = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  )
  const { error: mailErr } = await anon.auth.resend({
    type: 'signup',
    email,
    options: { emailRedirectTo: `${origin}/login` },
  })
  if (mailErr) {
    // Non-fatal: the account exists but the verification mail could not be sent
    // (commonly: SMTP not configured). Surface so the user isn't left guessing.
    logger.error('[register] verification email failed', { detail: mailErr.message })
    return NextResponse.json(
      { verifyEmail: true, emailSent: false },
      { status: 201 },
    )
  }

  return NextResponse.json({ verifyEmail: true, emailSent: true }, { status: 201 })
}
