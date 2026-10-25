// PATCH  /api/folders/:id/shares/:granteeId — change a member's role (owner only)
// DELETE /api/folders/:id/shares/:granteeId — remove a member
//                                             (folder owner OR the grantee removing themselves)

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireUser } from '@/lib/auth/server'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; granteeId: string }> },
) {
  let caller
  try { caller = await requireUser(req) } catch (res) { return res as NextResponse }

  const { id: folderId, granteeId } = await params

  let body: { role?: unknown }
  try { body = (await req.json()) as typeof body }
  catch { return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }) }

  const role = body.role
  if (role !== 'editor' && role !== 'viewer') {
    return NextResponse.json({ error: 'role must be "editor" or "viewer".' }, { status: 422 })
  }

  const db = createServerClient()

  // Only the folder owner can change roles
  const { data: folder } = await db
    .from('folders')
    .select('user_id')
    .eq('id', folderId)
    .maybeSingle()

  if (!folder) return NextResponse.json({ error: 'Folder not found.' }, { status: 404 })
  if (folder.user_id !== caller.id) return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })

  const { error } = await db
    .from('folder_shares')
    .update({ role })
    .eq('folder_id', folderId)
    .eq('user_id', granteeId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, role })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; granteeId: string }> },
) {
  let caller
  try { caller = await requireUser(req) } catch (res) { return res as NextResponse }

  const { id: folderId, granteeId } = await params
  const db = createServerClient()

  // Allowed: folder owner removes anyone, or the grantee removes themselves
  const { data: folder } = await db
    .from('folders')
    .select('user_id')
    .eq('id', folderId)
    .maybeSingle()

  if (!folder) return NextResponse.json({ error: 'Folder not found.' }, { status: 404 })

  const isOwner = folder.user_id === caller.id
  const isSelf  = granteeId === caller.id

  if (!isOwner && !isSelf) {
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })
  }

  const { error } = await db
    .from('folder_shares')
    .delete()
    .eq('folder_id', folderId)
    .eq('user_id', granteeId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
