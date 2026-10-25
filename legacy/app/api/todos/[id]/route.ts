// PATCH /api/todos/[id]
//
// Updates the status of a todo. Ownership is verified through the parent meeting.
// Allowed values: 'open', 'done', 'dismissed'.
// The UI only toggles open↔done; 'dismissed' is available for future use.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@/lib/supabase/server'
import { checkMeetingAccess } from '@/lib/access'
import { logger } from '@/lib/logger'
import type { Database, TodoStatus } from '@/types/database'

const ALLOWED_STATUSES: TodoStatus[] = ['open', 'done', 'dismissed']

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

  const { id: todoId } = await params

  let body: { status?: unknown }
  try {
    body = (await req.json()) as { status?: unknown }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  if (!body.status || !ALLOWED_STATUSES.includes(body.status as TodoStatus)) {
    return NextResponse.json(
      { error: `status must be one of: ${ALLOWED_STATUSES.join(', ')}.` },
      { status: 422 },
    )
  }
  const status = body.status as TodoStatus

  const db = createServerClient()

  // Resolve ownership via the parent meeting
  const { data: todo } = await db
    .from('todos')
    .select('id, meeting_id')
    .eq('id', todoId)
    .maybeSingle()

  if (!todo) return NextResponse.json({ error: 'Todo not found.' }, { status: 404 })

  const { data: meeting } = await db
    .from('meetings')
    .select('user_id, folder_id')
    .eq('id', todo.meeting_id)
    .maybeSingle()

  if (!meeting) return NextResponse.json({ error: 'Parent meeting not found.' }, { status: 404 })
  if (!(await checkMeetingAccess(db, meeting, userId, 'editor'))) {
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })
  }

  const { error: updateErr } = await db.from('todos').update({ status }).eq('id', todoId)

  if (updateErr) {
    logger.error('[todos] update failed', { detail: updateErr.message })
    return NextResponse.json({ error: 'Failed to update todo.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
