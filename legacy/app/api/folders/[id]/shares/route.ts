// GET  /api/folders/:id/shares — list members of a folder (owner only)
// POST /api/folders/:id/shares — add a member by email or username (owner only)
//
// POST body: { identifier: string, role: 'editor' | 'viewer' }
// Resolves identifier → existing user. Returns 404 if no account found.
// Returns 409 if the user is already a member or is the folder owner.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireUser } from '@/lib/auth/server'

function looksLikeEmail(s: string) {
  return s.includes('@')
}

function normalizeUsername(s: string) {
  return s.replace(/^@/, '').toLowerCase().trim()
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let caller
  try { caller = await requireUser(req) } catch (res) { return res as NextResponse }

  const { id: folderId } = await params
  const db = createServerClient()

  // Only the folder owner can list members
  const { data: folder } = await db
    .from('folders')
    .select('id, user_id')
    .eq('id', folderId)
    .maybeSingle()

  if (!folder) return NextResponse.json({ error: 'Folder not found.' }, { status: 404 })
  if (folder.user_id !== caller.id) return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })

  const { data: shareRows, error: shareErr } = await db
    .from('folder_shares')
    .select('user_id, role, created_at')
    .eq('folder_id', folderId)
    .order('created_at', { ascending: true })

  if (shareErr) return NextResponse.json({ error: shareErr.message }, { status: 500 })

  if (!shareRows || shareRows.length === 0) {
    return NextResponse.json({ members: [] })
  }

  // Resolve user IDs → usernames
  const userIds = shareRows.map((s) => s.user_id)
  const { data: profiles } = await db
    .from('profiles')
    .select('id, username')
    .in('id', userIds)

  const members = shareRows.map((s) => ({
    userId: s.user_id,
    username: profiles?.find((p) => p.id === s.user_id)?.username ?? s.user_id,
    role: s.role,
  }))

  return NextResponse.json({ members })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let caller
  try { caller = await requireUser(req) } catch (res) { return res as NextResponse }

  const { id: folderId } = await params

  let body: { identifier?: unknown; role?: unknown }
  try { body = (await req.json()) as typeof body }
  catch { return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }) }

  const identifier = typeof body.identifier === 'string' ? body.identifier.trim() : ''
  const role = body.role

  if (!identifier) return NextResponse.json({ error: 'identifier is required.' }, { status: 422 })
  if (role !== 'editor' && role !== 'viewer') {
    return NextResponse.json({ error: 'role must be "editor" or "viewer".' }, { status: 422 })
  }

  const db = createServerClient()

  // Caller must own the folder
  const { data: folder } = await db
    .from('folders')
    .select('id, user_id')
    .eq('id', folderId)
    .maybeSingle()

  if (!folder) return NextResponse.json({ error: 'Folder not found.' }, { status: 404 })
  if (folder.user_id !== caller.id) return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })

  // Resolve identifier → grantee user ID
  let granteeId: string
  let granteeUsername: string

  if (looksLikeEmail(identifier)) {
    const email = identifier.toLowerCase()
    // Look up by email via admin API (service role)
    const { data: { users }, error: listErr } = await db.auth.admin.listUsers()
    if (listErr) return NextResponse.json({ error: 'Failed to look up user.' }, { status: 500 })
    const found = users.find((u) => u.email?.toLowerCase() === email)
    if (!found) return NextResponse.json({ error: 'No account found with that email.' }, { status: 404 })
    granteeId = found.id

    const { data: profile } = await db.from('profiles').select('username').eq('id', granteeId).maybeSingle()
    granteeUsername = profile?.username ?? granteeId
  } else {
    const username = normalizeUsername(identifier)
    const { data: profile } = await db.from('profiles').select('id, username').eq('username', username).maybeSingle()
    if (!profile) return NextResponse.json({ error: 'No account found with that username.' }, { status: 404 })
    granteeId = profile.id
    granteeUsername = profile.username
  }

  // Cannot share with self
  if (granteeId === caller.id) {
    return NextResponse.json({ error: 'You cannot share a folder with yourself.' }, { status: 409 })
  }

  // Cannot share with the folder owner (they already have implicit owner access)
  if (granteeId === folder.user_id) {
    return NextResponse.json({ error: 'That user is already the folder owner.' }, { status: 409 })
  }

  const { error: insertErr } = await db.from('folder_shares').insert({
    folder_id: folderId,
    user_id: granteeId,
    role,
    invited_by: caller.id,
  })

  if (insertErr) {
    if (insertErr.code === '23505') {
      return NextResponse.json({ error: 'That user is already a member of this folder.' }, { status: 409 })
    }
    return NextResponse.json({ error: insertErr.message }, { status: 500 })
  }

  return NextResponse.json({ member: { userId: granteeId, username: granteeUsername, role } }, { status: 201 })
}
