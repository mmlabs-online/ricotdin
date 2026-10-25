// POST /api/users/lookup — resolve an email or username to a display-safe user record.
//
// Used by the share-folder UI to confirm an account exists before sending the
// share invitation. Returns only { id, username } — never exposes the full email
// back to the caller.
//
// Body: { identifier: string }  (email or username)
// Response 200: { id: string, username: string }
// Response 404: { error: "No account found…" }

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireUser } from '@/lib/auth/server'

function looksLikeEmail(s: string) {
  return s.includes('@')
}

function normalizeUsername(s: string) {
  return s.replace(/^@/, '').toLowerCase().trim()
}

export async function POST(req: NextRequest) {
  // Caller must be authenticated — any valid user can do a lookup
  try { await requireUser(req) } catch (res) { return res as NextResponse }

  let body: { identifier?: unknown }
  try { body = (await req.json()) as typeof body }
  catch { return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }) }

  const identifier = typeof body.identifier === 'string' ? body.identifier.trim() : ''
  if (!identifier) return NextResponse.json({ error: 'identifier is required.' }, { status: 422 })

  const db = createServerClient()

  if (looksLikeEmail(identifier)) {
    const email = identifier.toLowerCase()
    const { data: { users }, error } = await db.auth.admin.listUsers()
    if (error) return NextResponse.json({ error: 'Lookup failed.' }, { status: 500 })

    const user = users.find((u) => u.email?.toLowerCase() === email)
    if (!user) return NextResponse.json({ error: 'No account found with that email.' }, { status: 404 })

    const { data: profile } = await db.from('profiles').select('username').eq('id', user.id).maybeSingle()
    return NextResponse.json({ id: user.id, username: profile?.username ?? null })
  }

  const username = normalizeUsername(identifier)
  const { data: profile } = await db
    .from('profiles')
    .select('id, username')
    .eq('username', username)
    .maybeSingle()

  if (!profile) return NextResponse.json({ error: 'No account found with that username.' }, { status: 404 })

  return NextResponse.json({ id: profile.id, username: profile.username })
}
