// GET /api/admin/audit-logs?page=&perPage=&actor=&action=&from=&to=
//
// Returns paginated admin audit log entries.
// All fields are safe to expose; no transcript/notes content.
//
// SECURITY: requires admin role.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/server'
import { parseAuditQueryParams } from '@/lib/admin/audit-query'
import { logger } from '@/lib/logger'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  const { searchParams } = new URL(req.url)
  const { page, perPage, actor, action, from, to } = parseAuditQueryParams(searchParams)

  const db = createServerClient()

  let query = db
    .from('audit_logs')
    .select('id, actor_id, actor_email, action, target_type, target_id, metadata, ip_address, user_agent, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((page - 1) * perPage, page * perPage - 1)

  if (actor)  query = query.eq('actor_id', actor)
  if (action) query = query.like('action', `${action}%`)
  if (from)   query = query.gte('created_at', from)
  if (to)     query = query.lte('created_at', to + 'T23:59:59Z')

  const { data, error, count } = await query

  if (error) {
    logger.error('[admin/audit-logs] query failed', { detail: error.message })
    return NextResponse.json({ error: 'Failed to fetch audit logs.' }, { status: 500 })
  }

  return NextResponse.json({ logs: data ?? [], total: count ?? 0, page, perPage })
}
