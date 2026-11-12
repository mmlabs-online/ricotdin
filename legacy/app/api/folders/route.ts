// GET  /api/folders — list owned folders + shared folders (with role annotation)
// POST /api/folders — create a new folder (unique name per user, case-insensitive)
//
// GET response shape:
//   { folders: FolderWithRole[] }
//   myRole = 'owner'  for folders you created
//   myRole = 'editor' | 'viewer' for folders shared with you (ownerUsername set)

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@/lib/supabase/server'
import type { Database, FolderWithRole } from '@/types/database'

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

export async function GET(req: NextRequest) {
  let userId: string
  try { userId = await requireUser(req) } catch (e) { return e as NextResponse }

  const db = createServerClient()

  // Owned folders
  const { data: ownedData, error: ownedErr } = await db
    .from('folders')
    .select('*')
    .eq('user_id', userId)
    .order('position', { ascending: true })
    .order('name', { ascending: true })

  if (ownedErr) return NextResponse.json({ error: ownedErr.message }, { status: 500 })

  // Count members (folder_shares rows) for each owned folder
  const ownedIds = (ownedData ?? []).map((f) => f.id)
  const memberCounts: Record<string, number> = {}
  if (ownedIds.length > 0) {
    const { data: shareCountRows } = await db
      .from('folder_shares')
      .select('folder_id')
      .in('folder_id', ownedIds)
    for (const row of shareCountRows ?? []) {
      memberCounts[row.folder_id] = (memberCounts[row.folder_id] ?? 0) + 1
    }
  }

  const owned: FolderWithRole[] = (ownedData ?? []).map((f) => ({
    ...f,
    myRole: 'owner' as const,
    ownerUsername: null,
    memberCount: memberCounts[f.id] ?? 0,
  }))

  // Shared folders: find all folder_shares rows for this user
  const { data: shareRows, error: shareErr } = await db
    .from('folder_shares')
    .select('folder_id, role')
    .eq('user_id', userId)

  if (shareErr) return NextResponse.json({ error: shareErr.message }, { status: 500 })

  let shared: FolderWithRole[] = []

  if (shareRows && shareRows.length > 0) {
    const folderIds = shareRows.map((s) => s.folder_id)

    const { data: sharedFolderRows, error: sfErr } = await db
      .from('folders')
      .select('*')
      .in('id', folderIds)
      .order('name', { ascending: true })

    if (sfErr) return NextResponse.json({ error: sfErr.message }, { status: 500 })

    // Fetch owner usernames for display
    const ownerIds = [...new Set((sharedFolderRows ?? []).map((f) => f.user_id))]
    const { data: ownerProfiles } = await db
      .from('profiles')
      .select('id, username')
      .in('id', ownerIds)

    shared = (sharedFolderRows ?? []).map((f) => {
      const shareRow = shareRows.find((s) => s.folder_id === f.id)
      const ownerProfile = ownerProfiles?.find((p) => p.id === f.user_id)
      return {
        ...f,
        myRole: (shareRow?.role ?? 'viewer') as 'editor' | 'viewer',
        ownerUsername: ownerProfile?.username ?? null,
        memberCount: 0,
      }
    })
  }

  // Owned first (alphabetically), then shared (alphabetically)
  return NextResponse.json({ folders: [...owned, ...shared] })
}

export async function POST(req: NextRequest) {
  let userId: string
  try { userId = await requireUser(req) } catch (e) { return e as NextResponse }

  let body: { name?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 }) }

  const name = body.name?.trim()
  if (!name) return NextResponse.json({ error: 'name is required.' }, { status: 400 })
  if (name.length > 100) return NextResponse.json({ error: 'Folder name too long (max 100 characters).' }, { status: 400 })

  const db = createServerClient()

  // Append new folder after the last owned folder
  const { data: maxRow } = await db
    .from('folders')
    .select('position')
    .eq('user_id', userId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()
  const position = (maxRow?.position ?? -1) + 1

  const { data, error } = await db
    .from('folders')
    .insert({ user_id: userId, name, position })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: `A folder named "${name}" already exists.` }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ folder: { ...data, myRole: 'owner', ownerUsername: null, memberCount: 0 } }, { status: 201 })
}
