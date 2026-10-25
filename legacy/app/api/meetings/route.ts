// POST /api/meetings
// Creates a meetings row and returns a presigned R2 PUT URL for direct
// browser→R2 upload (CST-02). The service-role key stays server-only.
// The caller's JWT is verified via the anon-key client to identify the user.
//
// Response: { meetingId, uploadUrl, contentType }
//   uploadUrl  — R2 presigned PUT URL (15-minute TTL)
//   contentType — the value that was signed; the browser MUST send this exact
//                 string in the Content-Type header of the PUT request.

import { randomUUID } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { createClient } from '@supabase/supabase-js'
import {
  ALLOWED_AUDIO_EXTENSIONS,
  ALLOWED_VIDEO_EXTENSIONS,
  isAllowedExtension,
  isVideoExtension,
} from '@/lib/upload/constants'
import { createSignedUploadUrl } from '@/lib/storage'
import { canAssignToFolder } from '@/lib/access'
import { logActivity } from '@/lib/activity/logActivity'
import { requestContext } from '@/lib/admin/audit'
import { logger } from '@/lib/logger'
import type { Database } from '@/types/database'
import type { MeetingSource } from '@/types/database'

// LEGACY (pre-R2): bucket constant kept only for the commented-out Supabase path below.
// const BUCKET = 'recordings'

/** Verify the JWT and return the user_id, or throw a 401 response. */
async function requireUser(req: NextRequest): Promise<string> {
  const authHeader = req.headers.get('authorization')
  const token = authHeader?.replace(/^Bearer\s+/i, '').trim()
  if (!token) {
    throw NextResponse.json({ error: 'Missing Authorization header.' }, { status: 401 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !anonKey) {
    throw NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500 })
  }

  const authClient = createClient<Database>(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const {
    data: { user },
    error,
  } = await authClient.auth.getUser()
  if (error || !user) {
    throw NextResponse.json({ error: 'Invalid or expired session.' }, { status: 401 })
  }
  return user.id
}

/**
 * Normalise and whitelist a file extension sent by the client.
 * Accepts both audio and video extensions.
 * Throws a 400 NextResponse if the extension is unrecognised.
 */
function resolveExtension(raw?: string): string {
  if (!raw) return '.webm'
  const ext = raw.startsWith('.') ? raw.toLowerCase() : `.${raw.toLowerCase()}`
  if (!isAllowedExtension(ext) && !isVideoExtension(ext)) {
    throw NextResponse.json(
      {
        error:
          `Unsupported file extension "${ext}". ` +
          `Allowed audio: ${ALLOWED_AUDIO_EXTENSIONS.join(', ')}. ` +
          `Allowed video: ${ALLOWED_VIDEO_EXTENSIONS.join(', ')}.`,
      },
      { status: 400 },
    )
  }
  return ext
}

/** Derive a Content-Type from the client-supplied mimeType or the file extension. */
const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.m4v': 'video/mp4',
}

function resolveContentType(mimeType?: string, ext?: string): string {
  if (mimeType && mimeType !== 'application/octet-stream') return mimeType
  if (ext) return MIME_BY_EXT[ext] ?? 'application/octet-stream'
  return 'application/octet-stream'
}

export async function POST(req: NextRequest) {
  let userId: string
  try {
    userId = await requireUser(req)
  } catch (res) {
    return res as NextResponse
  }

  let body: {
    durationSeconds?: number
    startedAt?: string
    source?: string
    fileExtension?: string
    mimeType?: string
    folderId?: string | null
  }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  // Validate and resolve the file extension; throws 400 on unknown extension.
  let ext: string
  try {
    ext = resolveExtension(body.fileExtension)
  } catch (res) {
    return res as NextResponse
  }

  const source: MeetingSource =
    body.source === 'uploaded' ? 'uploaded'
    : body.source === 'video' ? 'video'
    : 'recorded'

  // Content-Type for the R2 presigned PUT. The browser must echo this exact
  // value in the PUT's Content-Type header or R2 returns 403.
  const contentType = resolveContentType(body.mimeType, ext)

  const serverClient = createServerClient()

  // LEGACY (pre-R2): Supabase bucket existence check — replaced by R2.
  // const { data: bucket, error: bucketError } = await serverClient.storage.getBucket(BUCKET)
  // if (bucketError || !bucket) {
  //   console.error('[meetings] bucket check failed:', bucketError?.message)
  //   return NextResponse.json(
  //     {
  //       error:
  //         'Storage bucket "recordings" not found. ' +
  //         'Create a PRIVATE bucket named "recordings" in the Supabase dashboard → Storage.',
  //     },
  //     { status: 503 },
  //   )
  // }

  const meetingId = randomUUID()
  const audioPath = `${userId}/${meetingId}${ext}`

  const title = formatMeetingTitle(body.startedAt)
  const startedAt = body.startedAt ?? new Date().toISOString()

  // Validate folder_id: caller must own it or have editor access to it
  const folderId = body.folderId ?? null
  if (folderId && !(await canAssignToFolder(serverClient, folderId, userId))) {
    return NextResponse.json({ error: 'Folder not found.' }, { status: 404 })
  }

  const { error: insertError } = await serverClient.from('meetings').insert({
    id: meetingId,
    user_id: userId,
    title,
    status: 'pending',
    source,
    storage_provider: 'r2',
    audio_path: audioPath,
    duration_seconds: body.durationSeconds ?? null,
    started_at: startedAt,
    folder_id: folderId,
  })

  if (insertError) {
    logger.error('[meetings] insert failed', { detail: insertError.message })
    return NextResponse.json({ error: 'Failed to create meeting record.' }, { status: 500 })
  }

  // LEGACY (pre-R2): Supabase signed upload URL — replaced by R2 presigned PUT below.
  // const { data: signedData, error: signedError } = await serverClient.storage
  //   .from(BUCKET)
  //   .createSignedUploadUrl(audioPath)
  // if (signedError || !signedData) {
  //   console.error('[meetings] createSignedUploadUrl failed:', signedError?.message)
  //   await serverClient.from('meetings').delete().eq('id', meetingId)
  //   return NextResponse.json({ error: 'Failed to create upload URL.' }, { status: 500 })
  // }
  // return NextResponse.json({ meetingId, path: signedData.path, token: signedData.token })

  let uploadUrl: string
  try {
    uploadUrl = await createSignedUploadUrl({ key: audioPath, contentType })
  } catch (err) {
    logger.error('[meetings] R2 createSignedUploadUrl failed', { detail: String(err) })
    // Roll back the meeting row so we don't have orphaned pending rows
    const { error: deleteErr } = await serverClient.from('meetings').delete().eq('id', meetingId)
    if (deleteErr) logger.warn('[meetings] rollback delete failed', { detail: deleteErr.message })
    return NextResponse.json({ error: 'Failed to create upload URL. Check R2 configuration.' }, { status: 500 })
  }

  const { ipAddress, userAgent } = requestContext(req)
  logActivity({ userId, eventType: 'meeting_created', meetingId, metadata: { source, title }, ip: ipAddress, userAgent })

  return NextResponse.json({ meetingId, uploadUrl, contentType })
}

function formatMeetingTitle(isoDate?: string): string {
  const d = isoDate ? new Date(isoDate) : new Date()
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}
