// POST /api/meetings/:id/uploaded
// Called by the client after a successful direct upload to Supabase Storage.
//
// For audio files (source='uploaded'):
//   Validates the uploaded file (size + ffprobe audio-stream check) and kicks
//   off the processing pipeline if everything is OK.
//
// For video files (source='video'):
//   Validates that the video has an audio track, then runs server-side ffmpeg
//   audio extraction, stores only the resulting mp3, updates the meeting row to
//   point at the mp3, deletes the original video from Storage, and fires the
//   pipeline. The pipeline never sees the video file.

import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { createClient } from '@supabase/supabase-js'
import { enqueueJob } from '@/lib/jobs/enqueue'
import { validateAudioStream, validateVideoAudioStream } from '@/lib/audio/ffprobe'
import { extractAudioFromVideo } from '@/lib/audio/transcode'
import { MAX_UPLOAD_BYTES } from '@/lib/upload/constants'
import {
  getObjectSize,
  createSignedDownloadUrl,
  uploadBytes,
  deleteObject,
} from '@/lib/storage'
import { logger } from '@/lib/logger'
import { isOwnedAudioKey } from '@/lib/retention/policy'
import type { Database } from '@/types/database'

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

/** Delete the meeting row and its storage object, then return a 422 response. */
async function rejectUpload(
  serverClient: ReturnType<typeof createServerClient>,
  meetingId: string,
  storagePath: string,
  provider: string,
  reason: string,
): Promise<NextResponse> {
  await deleteObject({ key: storagePath, provider }).catch((e: unknown) => {
    logger.warn('[uploaded] storage cleanup failed', { detail: String(e) })
  })
  const { error: deleteErr } = await serverClient.from('meetings').delete().eq('id', meetingId)
  if (deleteErr) logger.warn('[uploaded] meeting row cleanup failed', { detail: deleteErr.message })
  return NextResponse.json({ error: reason }, { status: 422 })
}

export async function POST(
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

  // AIP-06: optional model pick forwarded from the upload UI.
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const preferredProvider = typeof body.preferred_provider === 'string' ? body.preferred_provider : undefined
  const preferredModel    = typeof body.preferred_model    === 'string' ? body.preferred_model    : undefined

  const serverClient = createServerClient()

  // Verify the meeting belongs to this user
  const { data: meeting, error: fetchError } = await serverClient
    .from('meetings')
    .select('id, audio_path, user_id, source, storage_provider')
    .eq('id', meetingId)
    .single()

  if (fetchError || !meeting) {
    return NextResponse.json({ error: 'Meeting not found.' }, { status: 404 })
  }

  if (meeting.user_id !== userId) {
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })
  }

  // audio_path is user-editable under RLS, and the checks below read, transcode and may
  // delete it with service-role storage access: it must be this meeting's own object.
  if (meeting.audio_path && !isOwnedAudioKey(meeting.audio_path, meeting.user_id, meeting.id)) {
    return NextResponse.json({ error: 'Invalid audio path for this meeting.' }, { status: 422 })
  }

  // ── Confirm file exists + check size ─────────────────────────────────────
  if (meeting.audio_path) {
    const sizeBytes = await getObjectSize({
      key: meeting.audio_path,
      provider: meeting.storage_provider,
    }).catch((e: unknown) => {
      logger.warn('[uploaded] getObjectSize error (non-fatal)', { detail: String(e) })
      return null
    })

    if (sizeBytes === null) {
      return NextResponse.json(
        { error: 'File not found in storage — upload may have failed.' },
        { status: 422 },
      )
    }

    if (sizeBytes > MAX_UPLOAD_BYTES) {
      const mb = (MAX_UPLOAD_BYTES / (1024 * 1024)).toFixed(0)
      return rejectUpload(
        serverClient,
        meetingId,
        meeting.audio_path,
        meeting.storage_provider,
        `File exceeds the ${mb} MB upload limit.`,
      )
    }
  }

  // NOTE: uploads accelerate the storage cap — see CST-02 (Storage offload / R2)

  // ── Branch: video files need audio extraction ─────────────────────────────
  if (meeting.source === 'video' && meeting.audio_path) {
    const videoPath = meeting.audio_path
    const provider = meeting.storage_provider
    const finalAudioPath = `${meeting.user_id}/${meetingId}.mp3`
    const tmpAudioPath = join(tmpdir(), `${meetingId}-audio.mp3`)
    let audioUploaded = false

    try {
      // Longer TTL — ffmpeg will download the full video through this URL
      const videoUrl = await createSignedDownloadUrl({ key: videoPath, provider, expiresIn: 600 })

      // Validate that the video has an audio track (video streams are expected)
      await validateVideoAudioStream(videoUrl)

      // Extract audio — ffmpeg downloads the video via the signed URL
      await extractAudioFromVideo(videoUrl, tmpAudioPath)

      // Upload extracted mp3 to R2 (same provider as the video)
      const audioBuffer = await readFile(tmpAudioPath)
      await uploadBytes({ key: finalAudioPath, buffer: audioBuffer, contentType: 'audio/mpeg' })
      audioUploaded = true

      // Update meeting row to point at the extracted audio
      const { error: updateErr } = await serverClient
        .from('meetings')
        .update({ audio_path: finalAudioPath })
        .eq('id', meetingId)

      if (updateErr) throw new Error(`DB update failed: ${updateErr.message}`)

      // Delete the original video — the mp3 is the authoritative file now
      await deleteObject({ key: videoPath, provider }).catch((e: unknown) => {
        logger.warn('[uploaded] video cleanup after extraction failed (non-fatal)', { detail: String(e) })
      })

    } catch (err) {
      // Clean up temp file
      await unlink(tmpAudioPath).catch(() => {})
      // If the mp3 was already written to storage but the row update failed, remove it
      if (audioUploaded) {
        await deleteObject({ key: finalAudioPath, provider }).catch((e: unknown) => {
          logger.warn('[uploaded] partial audio cleanup failed', { detail: String(e) })
        })
      }
      const reason = err instanceof Error ? err.message : 'Video audio extraction failed.'
      return rejectUpload(serverClient, meetingId, videoPath, provider, reason)
    }

    // Temp file no longer needed
    await unlink(tmpAudioPath).catch(() => {})

    // Enqueue a durable job — survives server restarts (REL-01).
    await enqueueJob(meetingId, {
      ...(preferredProvider && preferredModel ? { preferred_provider: preferredProvider, preferred_model: preferredModel } : {}),
    })

    return NextResponse.json({ ok: true, meetingId })
  }

  // ── Audio-only: ffprobe validation ───────────────────────────────────────
  // Generate a short-lived signed URL so ffprobe can read stream headers
  // without downloading the full file. Skipped gracefully if ffprobe is absent.
  if (meeting.audio_path) {
    let audioUrl: string | null = null
    try {
      audioUrl = await createSignedDownloadUrl({
        key: meeting.audio_path,
        provider: meeting.storage_provider,
        expiresIn: 120, // 2-minute TTL
      })
    } catch (e: unknown) {
      logger.warn('[uploaded] could not generate signed read URL for ffprobe', { detail: String(e) })
    }

    if (audioUrl) {
      try {
        await validateAudioStream(audioUrl)
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'File is not a valid audio file.'
        return rejectUpload(serverClient, meetingId, meeting.audio_path, meeting.storage_provider, reason)
      }
    }
  }

  // Enqueue a durable job — survives server restarts (REL-01).
  await enqueueJob(meetingId, {
    ...(preferredProvider && preferredModel ? { preferred_provider: preferredProvider, preferred_model: preferredModel } : {}),
  })

  return NextResponse.json({ ok: true, meetingId })
}
