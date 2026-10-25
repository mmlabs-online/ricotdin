// GET /api/audio-url/[id]   ([id] = meetingId)
//
// Returns a short-lived signed URL for streaming the meeting's audio recording,
// plus the `user_hack_audio_render` flag the player needs to decide whether to
// force a seekable duration (see lib/audio/durationFix.ts).
// Access: viewer+ (meeting owner, folder owner, or shared member with any role).
// The recordings bucket is private — this route is the ONLY authorised way the
// browser gets a playback URL. Never expose permanent URLs.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@/lib/supabase/server'
import { createSignedDownloadUrl } from '@/lib/storage'
import { checkMeetingAccess } from '@/lib/access'
import { getAppConfigBool } from '@/lib/config/appConfig'
import { logger } from '@/lib/logger'
import { ownedAudioPath } from '@/lib/retention/policy'
import type { Database } from '@/types/database'

const SIGNED_URL_EXPIRY_SECS = 3_600 // 1 hour

/** app_config key: force a full-stream scan so unseekable WebM becomes seekable. */
const AUDIO_RENDER_HACK_KEY = 'user_hack_audio_render'

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

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let userId: string
  try {
    userId = await requireUser(req)
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
  // Viewer+ access is sufficient to receive a signed audio URL
  if (!(await checkMeetingAccess(db, meeting, userId, 'viewer'))) {
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })
  }
  // BUG-003: only ever sign this meeting's own object, never a forged audio_path.
  const audioKey = ownedAudioPath(meeting)
  if (meeting.audio_path && !audioKey) {
    logger.warn('[audio-url] audio_path does not belong to this meeting — refusing to sign', { meetingId: meeting.id, userId })
  }
  if (!audioKey) return NextResponse.json({ error: 'No audio for this meeting.' }, { status: 404 })

  let signedUrl: string
  try {
    signedUrl = await createSignedDownloadUrl({
      key: audioKey,
      provider: meeting.storage_provider,
      expiresIn: SIGNED_URL_EXPIRY_SECS,
    })
  } catch (err) {
    logger.error('[audio-url] createSignedDownloadUrl failed', { detail: String(err) })
    return NextResponse.json({ error: 'Failed to create signed URL.' }, { status: 500 })
  }

  // app_config is admin-read under RLS, so the flag is resolved here (service role)
  // and handed to the player rather than fetched by the browser.
  const hackAudioRender = await getAppConfigBool(AUDIO_RENDER_HACK_KEY, false)

  return NextResponse.json({ url: signedUrl, hackAudioRender })
}
