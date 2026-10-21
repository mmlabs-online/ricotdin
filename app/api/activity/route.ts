// POST /api/activity
//
// Client-side best-effort event hook for browser-generated events.
// Only CLIENT_EVENT_TYPES (record_start, record_stop, recording_notice_ack) are accepted.
// The caller can only log events for themselves — cross-user logging is
// rejected by the isCallerOwn guard.
//
// Rate limit: 10 events per user per minute (in-memory, MVP only).
// This is best-effort: a logging failure returns 200 and never breaks the UI.
//
// SECURITY: requires valid Bearer token; validates caller === userId.

import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/server'
import { logActivity } from '@/lib/activity/logActivity'
import { requestContext } from '@/lib/admin/audit'
import { CLIENT_EVENT_TYPES, validateEventType } from '@/lib/activity/types'
import { isCallerOwn } from '@/lib/activity/guards'

// ---------------------------------------------------------------------------
// In-memory rate limiter (max 10 client events per user per minute)
// ---------------------------------------------------------------------------

const RL_MAX     = 10
const RL_WINDOW  = 60_000

const _rlMap = new Map<string, { count: number; windowStart: number }>()

function checkRateLimit(userId: string): boolean {
  const now  = Date.now()
  const prev = _rlMap.get(userId)
  if (!prev || now - prev.windowStart > RL_WINDOW) {
    _rlMap.set(userId, { count: 1, windowStart: now })
    return true
  }
  if (prev.count >= RL_MAX) return false
  prev.count++
  return true
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  let caller
  try {
    caller = await requireUser(req)
  } catch (res) {
    return res as NextResponse
  }

  let body: { eventType?: unknown; userId?: unknown; meetingId?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const eventType = typeof body.eventType === 'string' ? body.eventType : ''
  const userId    = typeof body.userId    === 'string' ? body.userId    : ''
  const meetingId = typeof body.meetingId === 'string' ? body.meetingId : null

  // Only client event types are accepted here
  if (!validateEventType(eventType) || !CLIENT_EVENT_TYPES.has(eventType)) {
    return NextResponse.json(
      { error: `eventType must be one of: ${[...CLIENT_EVENT_TYPES].join(', ')}.` },
      { status: 422 },
    )
  }

  // Caller must match the userId they want to log (no cross-user logging)
  if (!isCallerOwn(caller.id, userId)) {
    return NextResponse.json({ error: 'Forbidden: userId must match the authenticated user.' }, { status: 403 })
  }

  // Rate limit
  if (!checkRateLimit(caller.id)) {
    return NextResponse.json({ error: 'Too many activity events. Slow down.' }, { status: 429 })
  }

  // Fire-and-forget — never fail the client
  const { ipAddress, userAgent } = requestContext(req)
  logActivity({
    userId: caller.id,
    eventType: eventType as 'record_start' | 'record_stop' | 'recording_notice_ack',
    meetingId,
    ip: ipAddress,
    userAgent,
  })

  return NextResponse.json({ ok: true })
}
