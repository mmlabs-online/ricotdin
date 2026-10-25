// GET /api/admin/activity?userId=&eventType=&from=&to=&page=&perPage=
//
// Paginated admin feed of activity_log entries.
// Optionally joins meeting title from meetings (no content columns).
//
// SECURITY: admin-only; service-role key server-only.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/server'
import { parseActivityQueryParams } from '@/lib/activity/parse'
import { logger } from '@/lib/logger'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  const { searchParams } = new URL(req.url)
  const { page, perPage, userId, eventType, from, to } = parseActivityQueryParams(searchParams)

  const db = createServerClient()

  let query = db
    .from('activity_log')
    .select(
      'id, created_at, user_id, event_type, meeting_id, target_user_id, metadata, ip, user_agent, meeting:meetings(title)',
      { count: 'exact' },
    )
    .order('created_at', { ascending: false })
    .range((page - 1) * perPage, page * perPage - 1)

  if (userId)    query = query.eq('user_id', userId)
  if (eventType) query = query.eq('event_type', eventType)
  if (from)      query = query.gte('created_at', from)
  if (to)        query = query.lte('created_at', to + 'T23:59:59Z')

  const { data, error, count } = await query

  if (error) {
    logger.error('[admin/activity] query failed', { detail: error.message })
    return NextResponse.json({ error: 'Failed to fetch activity log.' }, { status: 500 })
  }

  // Flatten the joined meeting title into the row
  const rows = (data ?? []).map((row) => ({
    id:             row.id,
    created_at:     row.created_at,
    user_id:        row.user_id,
    event_type:     row.event_type,
    meeting_id:     row.meeting_id,
    meeting_title:  (row.meeting as { title?: string } | null)?.title ?? null,
    target_user_id: row.target_user_id,
    metadata:       row.metadata,
    ip:             row.ip,
    user_agent:     row.user_agent,
  }))

  return NextResponse.json({ rows, total: count ?? 0, page, perPage })
}
