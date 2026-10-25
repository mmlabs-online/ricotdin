// PATCH  /api/folders/:id — rename a folder
// DELETE /api/folders/:id?deleteMeetings=true — delete folder + all meetings inside (with Storage cleanup)
// DELETE /api/folders/:id                     — delete folder only; meetings move to Uncategorized (ON DELETE SET NULL)

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@/lib/supabase/server'
import type { Database } from '@/types/database'
import { ownedAudioDeleteItems, ownMeetingsOnly } from '@/lib/retention/policy'
import { logActivity } from '@/lib/activity/logActivity'
import { meetingDeletedActivity } from '@/lib/activity/entries'
import { requestContext } from '@/lib/admin/audit'
import { deleteObjects } from '@/lib/storage'
import { logger } from '@/lib/logger'

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

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let userId: string
  try { userId = await requireUser(req) } catch (e) { return e as NextResponse }

  const { id } = await params
  let body: { name?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 }) }

  const name = body.name?.trim()
  if (!name) return NextResponse.json({ error: 'name is required.' }, { status: 400 })
  if (name.length > 100) return NextResponse.json({ error: 'Folder name too long (max 100 characters).' }, { status: 400 })

  const serverClient = createServerClient()

  // Verify ownership
  const { data: existing, error: fetchError } = await serverClient
    .from('folders')
    .select('id')
    .eq('id', id)
    .eq('user_id', userId)
    .single()

  if (fetchError || !existing) return NextResponse.json({ error: 'Folder not found.' }, { status: 404 })

  const { data, error } = await serverClient
    .from('folders')
    .update({ name, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: `A folder named "${name}" already exists.` }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ folder: data })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let userId: string
  try { userId = await requireUser(req) } catch (e) { return e as NextResponse }

  const { id } = await params
  const serverClient = createServerClient()

  // Verify ownership before deleting
  const { data: existing, error: fetchError } = await serverClient
    .from('folders')
    .select('id')
    .eq('id', id)
    .eq('user_id', userId)
    .single()

  if (fetchError || !existing) return NextResponse.json({ error: 'Folder not found.' }, { status: 404 })

  const deleteMeetings = req.nextUrl.searchParams.get('deleteMeetings') === 'true'

  if (deleteMeetings) {
    // Collect audio paths so we can clean up Storage before deleting rows
    // Only the caller's own meetings (BUG-011): a shared-folder editor's meetings in this folder are
    // not the owner's to delete — they fall back to Uncategorized when the folder is deleted below.
    const { data: folderMeetings, error: selectErr } = await serverClient
      .from('meetings')
      .select('id, user_id, audio_path, storage_provider')
      .eq('folder_id', id)
      .eq('user_id', userId)
    if (selectErr) {
      // Without the list we'd delete the folder and silently move its meetings to Uncategorized.
      logger.error('[folders] meetings lookup failed', { detail: selectErr.message })
      return NextResponse.json({ error: 'Failed to delete the meetings in this folder.' }, { status: 500 })
    }

    const meetingRows = ownMeetingsOnly(folderMeetings ?? [], userId)

    // Only each meeting's own object, each from its own provider (R2 or legacy Supabase) — BUG-004.
    const audioItems = ownedAudioDeleteItems(meetingRows)
    if (audioItems.length > 0) {
      // Storage failure is non-fatal — proceed with row deletion regardless
      const failed = await deleteObjects(audioItems)
      if (failed.length > 0) {
        logger.warn('[folders] audio storage cleanup failed (proceeding with row delete)', { count: failed.length })
      }
    }

    // Delete all meetings in the folder (transcript_segments, todos etc. cascade)
    const meetingIds = meetingRows.map((m) => m.id)
    if (meetingIds.length > 0) {
      const { error: meetingsErr } = await serverClient.from('meetings').delete().in('id', meetingIds)
      if (meetingsErr) {
        logger.error('[folders] meetings delete failed', { detail: meetingsErr.message })
        return NextResponse.json({ error: 'Failed to delete the meetings in this folder.' }, { status: 500 })
      }
      const { ipAddress, userAgent } = requestContext(req)
      for (const meetingId of meetingIds) {
        logActivity({ userId, ...meetingDeletedActivity(meetingId), ip: ipAddress, userAgent })
      }
    }
  }

  // Delete the folder; when deleteMeetings=false, ON DELETE SET NULL moves meetings to Uncategorized
  const { error } = await serverClient
    .from('folders')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
