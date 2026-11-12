// POST /api/auth/logout
//
// Server-side logout hook. The client calls this BEFORE clearing its local
// session so we can record the logout event in activity_log.
//
// The actual session invalidation still happens client-side via
// browserClient.auth.signOut() — Supabase does not require a server call
// to revoke tokens on the free tier. This route is purely for observability.
//
// SECURITY: requires a valid Bearer token (the session being logged out).

import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/server'
import { logActivity } from '@/lib/activity/logActivity'
import { requestContext } from '@/lib/admin/audit'

export async function POST(req: NextRequest) {
  let caller
  try {
    caller = await requireUser(req)
  } catch (res) {
    return res as NextResponse
  }

  const { ipAddress, userAgent } = requestContext(req)
  logActivity({
    userId: caller.id,
    eventType: 'logout',
    ip: ipAddress,
    userAgent,
  })

  return NextResponse.json({ ok: true })
}
