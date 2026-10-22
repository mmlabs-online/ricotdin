// PATCH /api/meetings/[id] — rename a meeting or move it to a folder.
// DELETE /api/meetings/[id] — delete meeting row + audio from Supabase Storage.
//
// PATCH body: { title?: string, folder_id?: string | null }
//   title is trimmed; must be non-empty, max 200 characters.
//   folder_id: UUID of the target folder (caller must own or have editor access), or null.
//
// DELETE: removes the audio object from Supabase Storage at meetings.audio_path
//   before deleting the row. Storage failure is non-fatal. ON DELETE CASCADE
//   handles all child rows.
//
// SECURITY:
//   PATCH requires editor+ access (meeting owner, folder owner, or editor member).
//   DELETE requires owner-only (SEC-03 FINDING-2).
//   Folder destination on PATCH requires the caller to have editor+ on that folder.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireUser } from '@/lib/auth/server'
import { deleteObject } from '@/lib/storage'
import { isOwnedAudioKey } from '@/lib/retention/policy'
import { checkMeetingAccess, canAssignToFolder } from '@/lib/access'
import { logActivity } from '@/lib/activity/logActivity'
import { meetingDeletedActivity } from '@/lib/activity/entries'
import { requestContext } from '@/lib/admin/audit'
import { logger } from '@/lib/logger'

const MAX_TITLE_LEN = 200

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let caller
  try {
    caller = await requireUser(req)
  } catch (res) {
    return res as NextResponse
  }

  const { id: meetingId } = await params

  let body: { title?: unknown; folder_id?: unknown }
  try {
    body = (await req.json()) as { title?: unknown; folder_id?: unknown }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  // Build typed update payload — at least one field must be present
  let newTitle: string | undefined
  let newFolderId: string | null | undefined

  if ('title' in body) {
    if (typeof body.title !== 'string') {
      return NextResponse.json({ error: 'title must be a string.' }, { status: 422 })
    }
    const t = body.title.trim()
    if (!t) return NextResponse.json({ error: 'title must not be empty.' }, { status: 422 })
    if (t.length > MAX_TITLE_LEN) {
      return NextResponse.json({ error: `title must be ${MAX_TITLE_LEN} characters or fewer.` }, { status: 422 })
    }
    newTitle = t
  }

  if ('folder_id' in body) {
    if (body.folder_id !== null && typeof body.folder_id !== 'string') {
      return NextResponse.json({ error: 'folder_id must be a UUID string or null.' }, { status: 422 })
    }
    newFolderId = (body.folder_id as string | null) ?? null
  }

  if (newTitle === undefined && newFolderId === undefined) {
    return NextResponse.json({ error: 'No updatable fields provided.' }, { status: 422 })
  }

  const db = createServerClient()

  const { data: meeting } = await db
    .from('meetings')
    .select('id, user_id, folder_id')
    .eq('id', meetingId)
    .maybeSingle()

  if (!meeting) return NextResponse.json({ error: 'Meeting not found.' }, { status: 404 })

  // Editor+ required to rename or move a meeting
  if (!(await checkMeetingAccess(db, meeting, caller.id, 'editor'))) {
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })
  }

  // If moving to a folder, verify the caller has editor+ on the destination
  if (newFolderId) {
    if (!(await canAssignToFolder(db, newFolderId, caller.id))) {
      return NextResponse.json({ error: 'Folder not found.' }, { status: 404 })
    }
  }

  const updatePayload: { title?: string; folder_id?: string | null } = {}
  if (newTitle !== undefined) updatePayload.title = newTitle
  if (newFolderId !== undefined) updatePayload.folder_id = newFolderId

  const { error: updateErr } = await db
    .from('meetings')
    .update(updatePayload)
    .eq('id', meetingId)

  if (updateErr) {
    logger.error('[meetings] update failed', { detail: updateErr.message })
    return NextResponse.json({ error: 'Failed to update meeting.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, ...updatePayload })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let caller
  try {
    caller = await requireUser(req)
  } catch (res) {
    return res as NextResponse
  }

  const { id: meetingId } = await params
  const db = createServerClient()

  const { data: meeting } = await db
    .from('meetings')
    .select('id, user_id, folder_id, audio_path, storage_provider')
    .eq('id', meetingId)
    .maybeSingle()

  if (!meeting) return NextResponse.json({ error: 'Meeting not found.' }, { status: 404 })

  // Only the meeting owner may delete (FINDING-2 / SEC-03)
  if (meeting.user_id !== caller.id) {
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })
  }

  // Delete audio from storage first. Failure here is non-fatal.
  let storageWarning: string | null = null
  // audio_path is user-editable under RLS: only delete this meeting's own object.
  if (meeting.audio_path && !isOwnedAudioKey(meeting.audio_path, meeting.user_id, meeting.id)) {
    logger.warn('[meetings] audio_path does not belong to this meeting — skipping storage delete', { meetingId: meeting.id })
  } else if (meeting.audio_path) {
    try {
      await deleteObject({ key: meeting.audio_path, provider: meeting.storage_provider })
    } catch (storageErr) {
      logger.warn('[meetings] storage delete failed (proceeding with row delete)', { detail: String(storageErr) })
      storageWarning = 'Audio file could not be removed from storage.'
    }
  }

  // Row delete — cascade removes transcript_segments, transcript_chunks, todos,
  // calendar_suggestions, and chat_sessions (+ chat_messages via sessions).
  const { error: deleteErr } = await db.from('meetings').delete().eq('id', meetingId)
  if (deleteErr) {
    logger.error('[meetings] row delete failed', { detail: deleteErr.message })
    return NextResponse.json({ error: 'Failed to delete meeting.' }, { status: 500 })
  }

  const { ipAddress, userAgent } = requestContext(req)
  logActivity({ userId: caller.id, ...meetingDeletedActivity(meetingId), ip: ipAddress, userAgent })

  return NextResponse.json({
    ok: true,
    ...(storageWarning ? { warning: storageWarning } : {}),
  })
}
