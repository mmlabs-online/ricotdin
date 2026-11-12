// GET /api/calendar-suggestions/[id]/ics
//
// Downloads a .ics file for the given calendar suggestion. Requires a valid
// session and verifies that the suggestion belongs to the requesting user via
// the parent meeting's user_id.
//
// Returns: text/calendar with VEVENT for the suggestion.
// 422 when proposed_at is null (no specific time — cannot generate valid ICS).

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@/lib/supabase/server'
import { checkMeetingAccess } from '@/lib/access'
import { buildSuggestionIcs } from '@/lib/ics'
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

export async function GET(
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
  const db = createServerClient()

  // Fetch suggestion (service role bypasses RLS)
  const { data: suggestion } = await db
    .from('calendar_suggestions')
    .select('id, meeting_id, title, proposed_at, raw_mention')
    .eq('id', suggestionId)
    .maybeSingle()

  if (!suggestion) return NextResponse.json({ error: 'Suggestion not found.' }, { status: 404 })

  // Viewer+ access is sufficient to download a calendar file
  const { data: meeting } = await db
    .from('meetings')
    .select('user_id, folder_id')
    .eq('id', suggestion.meeting_id)
    .maybeSingle()

  if (!meeting) return NextResponse.json({ error: 'Parent meeting not found.' }, { status: 404 })
  if (!(await checkMeetingAccess(db, meeting, userId, 'viewer'))) {
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })
  }

  // proposed_at === null → no specific time; refuse to fabricate a datetime
  if (!suggestion.proposed_at) {
    return NextResponse.json(
      {
        error:
          'This event has no specific date/time — cannot generate a calendar file. ' +
          'Add the event to your calendar manually.',
      },
      { status: 422 },
    )
  }

  let icsContent: string
  try {
    icsContent = buildSuggestionIcs(suggestion)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('[ics] buildSuggestionIcs failed', { detail: message })
    return NextResponse.json({ error: 'Failed to generate calendar file.' }, { status: 500 })
  }

  const filename = suggestion.title
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60) || 'event'

  return new Response(icsContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}.ics"`,
      'Cache-Control': 'no-store',
    },
  })
}
