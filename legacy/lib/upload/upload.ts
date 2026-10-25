// Client-side upload helpers.
// All functions run in the browser only — do not import from server code.

// LEGACY (pre-R2): browserClient was used for uploadToSignedUrl to Supabase Storage.
// import { browserClient } from '@/lib/supabase/browser'
import { getAccessToken } from '@/lib/supabase/auth'

// LEGACY (pre-R2): bucket constant kept for reference only.
// const BUCKET = 'recordings'

export interface RecordingMeta {
  /** Duration in seconds. Pass 0 when unknown (e.g. uploaded files). */
  durationSeconds: number
  /** ISO 8601 timestamp of when the meeting took place (recording start or user-selected date). */
  startedAt: string
  /** MIME type of the audio blob. Sent to the server so it can sign the R2 URL
   *  with the correct Content-Type. The browser PUT must echo the same value. */
  mimeType?: string
  /** 'recorded' (default), 'uploaded', or 'video'. Stored in meetings.source. */
  source?: 'recorded' | 'uploaded' | 'video'
  /** File extension with leading dot, e.g. '.mp3'. Used to build the storage path. */
  fileExtension?: string
  /** UUID of the folder to assign this meeting to. null / undefined = Uncategorized. */
  folderId?: string | null
  /** AIP-06: optional model pick from the record/upload UI.  null / undefined = use fallback chain. */
  preferredProvider?: string | null
  preferredModel?: string | null
}

export interface UploadResult {
  meetingId: string
}

/**
 * Full upload flow for a single recording or uploaded file:
 * 1. Ensure auth session.
 * 2. POST /api/meetings → get R2 presigned PUT URL + signed Content-Type.
 * 3. PUT blob directly to R2 (plain fetch — Content-Type must match signed value).
 * 4. POST /api/meetings/:id/uploaded → confirm + trigger pipeline.
 */
export async function uploadRecording(
  blob: Blob,
  meta: RecordingMeta,
): Promise<UploadResult> {
  const token = await getAccessToken()
  if (!token) throw new UploadError('Not authenticated. Please sign in.', 'auth')

  // Step 1: create meeting row + R2 presigned PUT URL
  const createRes = await fetch('/api/meetings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      durationSeconds: meta.durationSeconds,
      startedAt: meta.startedAt,
      source: meta.source ?? 'recorded',
      fileExtension: meta.fileExtension,
      mimeType: meta.mimeType,
      folderId: meta.folderId ?? null,
    }),
  })

  if (!createRes.ok) {
    const body = await createRes.json().catch(() => ({ error: `HTTP ${createRes.status}` })) as { error?: string }
    throw new UploadError(body.error ?? `HTTP ${createRes.status}`, 'create')
  }

  const { meetingId, uploadUrl, contentType } = (await createRes.json()) as {
    meetingId: string
    uploadUrl: string
    contentType: string
  }

  // Step 2: upload blob directly to R2 via presigned PUT.
  // Content-Type MUST match what the server signed — R2 returns 403 on mismatch.
  //
  // LEGACY (pre-R2): replaced Supabase uploadToSignedUrl with plain fetch PUT.
  // const { error: uploadError } = await browserClient.storage
  //   .from(BUCKET)
  //   .uploadToSignedUrl(path, uploadToken, blob, { contentType: meta.mimeType || blob.type || 'audio/webm' })
  // if (uploadError) throw new UploadError(`Storage upload failed: ${uploadError.message}`, 'upload')
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: blob,
  })
  if (!putRes.ok) {
    throw new UploadError(`Storage upload failed: HTTP ${putRes.status}`, 'upload')
  }

  // Step 3: confirm upload to server — triggers ffprobe/ffmpeg validation + pipeline
  const confirmRes = await fetch(`/api/meetings/${meetingId}/uploaded`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      preferred_provider: meta.preferredProvider ?? null,
      preferred_model: meta.preferredModel ?? null,
    }),
  })

  if (!confirmRes.ok) {
    const body = await confirmRes.json().catch(() => ({ error: `HTTP ${confirmRes.status}` })) as { error?: string }
    // Server may return 422 for invalid file type, size exceeded, or ffmpeg error.
    throw new UploadError(body.error ?? `HTTP ${confirmRes.status}`, 'confirm')
  }

  return { meetingId }
}

/** Typed error that carries which step failed for better UI messaging. */
export class UploadError extends Error {
  constructor(
    message: string,
    public readonly step: 'auth' | 'create' | 'upload' | 'confirm',
  ) {
    super(message)
    this.name = 'UploadError'
  }
}
