// PATCH /api/calendar-suggestions/[id]
//
// Sets dismissed=true on a calendar suggestion. Ownership verified via parent meeting.
// Only accepts { dismissed: true } — undismiss is not a supported operation for MVP.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@/lib/supabase/server'
import { checkMeetingAccess } from '@/lib/access'
import { logger } from '@/lib/logger'
import type { Database } from '@/types/database'

async function requireUser(req: NextRequest): Promise<string> {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (!token) throw NextResponse.json({ error: 'Missing Authorization header.' }, { status: 401 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) throw NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500 })

  const {
    data: { user },
    error,
  } = await createClient<Database>(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth.getUser()

  if (error || !user) throw NextResponse.json({ error: 'Invalid or expired session.' }, { status: 401 })
  return user.id
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let userId: string
  try {
    userId = await requireUser(req)
  } catch (res) {
    return res as NextResponse
  }

  const { id: suggestionId } = await params

  let body: { dismissed?: unknown }
  try {
    body = (await req.json()) as { dismissed?: unknown }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  if (body.dismissed !== true) {
    return NextResponse.json({ error: 'dismissed must be true.' }, { status: 422 })
  }

  const db = createServerClient()

  // Resolve ownership via the parent meeting
  const { data: suggestion } = await db
    .from('calendar_suggestions')
    .select('id, meeting_id')
    .eq('id', suggestionId)
    .maybeSingle()

  if (!suggestion) return NextResponse.json({ error: 'Suggestion not found.' }, { status: 404 })

  const { data: meeting } = await db
    .from('meetings')
    .select('user_id, folder_id')
    .eq('id', suggestion.meeting_id)
    .maybeSingle()

  if (!meeting) return NextResponse.json({ error: 'Parent meeting not found.' }, { status: 404 })
  if (!(await checkMeetingAccess(db, meeting, userId, 'editor'))) {
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })
  }

  const { error: updateErr } = await db
    .from('calendar_suggestions')
    .update({ dismissed: true })
    .eq('id', suggestionId)

  if (updateErr) {
    logger.error('[calendar-suggestions] update failed', { detail: updateErr.message })
    return NextResponse.json({ error: 'Failed to dismiss suggestion.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
