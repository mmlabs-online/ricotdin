// PUT /api/folders/reorder — persist drag-and-drop folder order
// Body: { order: string[] } — folder IDs in the new desired order.
// Only updates folders owned by the authenticated user; shared folders are silently skipped.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@/lib/supabase/server'
import type { Database } from '@/types/database'

async function requireUser(req: NextRequest): Promise<string> {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (!token) throw NextResponse.json({ error: 'Missing Authorization header.' }, { status: 401 })

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !anonKey) throw NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500 })

  const authClient = createClient<Database>(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: { user }, error } = await authClient.auth.getUser()
  if (error || !user) throw NextResponse.json({ error: 'Invalid or expired session.' }, { status: 401 })
  return user.id
}

export async function PUT(req: NextRequest) {
  let userId: string
  try { userId = await requireUser(req) } catch (e) { return e as NextResponse }

  let body: { order?: unknown }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
  }

  if (!Array.isArray(body.order)) {
    return NextResponse.json({ error: 'order must be an array of folder IDs.' }, { status: 400 })
  }
  const order = (body.order as unknown[]).filter((id): id is string => typeof id === 'string')
  if (order.length === 0) return NextResponse.json({ ok: true })

  const db = createServerClient()
  const now = new Date().toISOString()

  // Update each folder's position in parallel; ownership enforced by user_id filter
  await Promise.all(
    order.map((id, idx) =>
      db.from('folders')
        .update({ position: idx, updated_at: now })
        .eq('id', id)
        .eq('user_id', userId),
    ),
  )

  return NextResponse.json({ ok: true })
}
