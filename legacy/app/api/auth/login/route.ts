// POST /api/auth/login
//
// Accepts { identifier, password } where identifier is EITHER an email OR a
// username. If it looks like an email, signs in directly. Otherwise resolves
// the username → email server-side (service role, never exposed to client)
// and then calls signInWithPassword with the resolved email.
//
// Always returns a generic error on failure — never reveals whether the
// username/email exists or whether the password was wrong.
//
// SECURITY: username→email lookup happens server-side only.
// SECURITY: service role key never leaves the server.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@/lib/supabase/server'
import { normalizeUsername, looksLikeEmail } from '@/lib/auth/validate'
import { logActivity } from '@/lib/activity/logActivity'
import { requestContext } from '@/lib/admin/audit'
import { loginLimiter } from '@/lib/security/rateLimit'
import { logger } from '@/lib/logger'
import type { Database } from '@/types/database'

const GENERIC_ERROR = 'Invalid credentials. Please check your email or username and password.'

export async function POST(req: NextRequest) {
  let body: { identifier?: string; password?: string }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const identifier = (body.identifier ?? '').trim()
  const password = body.password ?? ''

  if (!identifier || !password) {
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 })
  }

  // ── Rate-limit check ───────────────────────────────────────────────────────
  // Key: client IP. Falls back to '__unknown__' so null-IP traffic shares one
  // bucket rather than bypassing the limit.
  // NOTE: relies on x-forwarded-for / x-real-ip set by the reverse proxy. If
  // the server is directly internet-facing with no proxy, add an env var to
  // read req.socket.remoteAddress instead (prevents header spoofing).
  const { ipAddress } = requestContext(req)
  const rateLimitKey = ipAddress ?? '__unknown__'
  const limitResult = loginLimiter.check(rateLimitKey)

  if (!limitResult.allowed) {
    logger.warn('[rate-limit] login blocked', { step: 'rate_limit' })
    const minutes = Math.ceil(limitResult.retryAfterSeconds / 60)
    return NextResponse.json(
      { error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` },
      {
        status: 429,
        headers: { 'Retry-After': String(limitResult.retryAfterSeconds) },
      },
    )
  }

  // ── Resolve identifier → email ─────────────────────────────────────────────
  let email: string

  if (looksLikeEmail(identifier)) {
    email = identifier.toLowerCase()
  } else {
    // Username lookup — server-side only via service role
    const username = normalizeUsername(identifier)
    const db = createServerClient()

    // Step 1: find the user ID by username in profiles
    const { data: profile } = await db
      .from('profiles')
      .select('id')
      .eq('username', username)
      .maybeSingle()

    if (!profile) {
      loginLimiter.recordFailure(rateLimitKey)
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 })
    }

    // Step 2: get the email for that user ID via the admin API
    const { data: { user: authUser } } = await db.auth.admin.getUserById(profile.id)

    if (!authUser?.email) {
      loginLimiter.recordFailure(rateLimitKey)
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 })
    }

    email = authUser.email
  }

  // ── Sign in with the resolved email ───────────────────────────────────────
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

  const { data, error } = await createClient<Database>(url, anonKey, {
    auth: { persistSession: false },
  }).auth.signInWithPassword({ email, password })

  if (error || !data.session) {
    // Count every failed sign-in (wrong creds, unverified, banned) as a failure.
    loginLimiter.recordFailure(rateLimitKey)

    const msg = error?.message?.toLowerCase() ?? ''
    const code = (error as { code?: string } | null)?.code ?? ''
    if (msg.includes('not confirmed') || code === 'email_not_confirmed') {
      return NextResponse.json(
        { error: 'Please verify your email before signing in. Check your inbox for the verification link.' },
        { status: 403 },
      )
    }
    if (msg.includes('banned') || code === 'user_banned') {
      return NextResponse.json(
        { error: 'Your account has been disabled. Please contact an administrator.' },
        { status: 403 },
      )
    }
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 })
  }

  // Successful auth — clear the failure bucket for this IP.
  loginLimiter.reset(rateLimitKey)

  const { userAgent } = requestContext(req)
  logActivity({
    userId: data.user!.id,
    eventType: 'login',
    metadata: { email: data.user?.email ?? null },
    ip: rateLimitKey === '__unknown__' ? null : rateLimitKey,
    userAgent,
  })

  return NextResponse.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    user: {
      id: data.user?.id,
      email: data.user?.email,
    },
  })
}
