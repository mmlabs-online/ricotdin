// GET /api/admin/pipeline/jobs?status=&page=&perPage=
//
// Paginated list of all meetings as pipeline jobs.
// Returns metadata only — no transcript/notes/audio content.
//
// Query params:
//   status   — filter by 'pending'|'processing'|'done'|'failed'|'stuck'
//              ('stuck' = processing older than 15 min)
//   page     — 1-indexed page number (default 1)
//   perPage  — rows per page, max 100 (default 20)
//
// SECURITY: requires admin role (server-enforced via requireAdmin).

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/server'
import { logger } from '@/lib/logger'

const STUCK_THRESHOLD_MINUTES = 15

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  const { searchParams } = new URL(req.url)
  const statusFilter = searchParams.get('status')?.toLowerCase().trim() ?? ''
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
  const perPage = Math.min(100, Math.max(1, parseInt(searchParams.get('perPage') ?? '20', 10)))

  const db = createServerClient()

  // Fetch meeting job metadata (no transcript/summary/notes content).
  // Service-role client bypasses RLS — returns all users' meetings.
  let query = db
    .from('meetings')
    .select('id, title, status, created_at, updated_at, duration_seconds, error_message, user_id')
    .order('created_at', { ascending: false })

  // 'stuck' is a derived status — filter on 'processing' then refine in JS.
  if (statusFilter && statusFilter !== 'stuck') {
    query = query.eq('status', statusFilter as import('@/types/database').MeetingStatus)
  } else if (statusFilter === 'stuck') {
    query = query.eq('status', 'processing')
  }

  const { data: meetings, error } = await query

  if (error) {
    logger.error('[admin/pipeline/jobs] fetch failed', { detail: error.message })
    return NextResponse.json({ error: 'Failed to fetch pipeline jobs.' }, { status: 500 })
  }

  // Fetch profiles for username lookup.
  const { data: profiles } = await db.from('profiles').select('id, username')
  const profileMap = new Map((profiles ?? []).map((p) => [p.id, p.username as string | null]))

  // Fetch all auth users for email lookup (same approach as admin/users endpoint).
  const { data: { users: authUsers } } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 })
  const emailMap = new Map((authUsers ?? []).map((u) => [u.id, u.email ?? null]))

  const stuckCutoff = Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000

  const allJobs = (meetings ?? [])
    .filter((m) => {
      if (statusFilter !== 'stuck') return true
      return new Date(m.updated_at).getTime() < stuckCutoff
    })
    .map((m) => ({
      id: m.id,
      title: m.title as string | null,
      status: m.status as string,
      created_at: m.created_at,
      updated_at: m.updated_at,
      duration_seconds: m.duration_seconds as number | null,
      error_message: m.error_message as string | null,
      owner_email: emailMap.get(m.user_id) ?? null,
      owner_username: profileMap.get(m.user_id) ?? null,
      is_stuck:
        m.status === 'processing' &&
        new Date(m.updated_at).getTime() < stuckCutoff,
    }))

  const total = allJobs.length
  const offset = (page - 1) * perPage
  const jobs = allJobs.slice(offset, offset + perPage)

  return NextResponse.json({ jobs, total, page, perPage })
}
