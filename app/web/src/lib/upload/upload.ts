// Meeting upload flow (ARC-12; v1 lib/upload/upload.ts adapted to Google Drive, CLAUDE.md §0.4/§0.6):
//   1. POST /meetings  → pending meeting + one-time Drive resumable session URL
//   2. PUT the file straight to Drive (browser → Google, with progress) → Drive file id
//   3. POST /meetings/{id}/uploaded {fileId, size} → the API verifies the file and queues processing
// The session URL is a bearer credential: never logged, never stored, only PUT to the Drive host.

import { apiErrorFrom } from '../../api/errors'
import type { UploadSource } from './rules'

// Drive's resumable session URIs (`create_session` in gdrive.py); the CSP allows only this path.
export const DRIVE_UPLOAD_PREFIX = 'https://www.googleapis.com/upload/drive/v3/files?'
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/

export type UploadStep = 'create' | 'upload' | 'confirm'

/** What a confirm-only retry needs: the file is already in Drive. */
export interface PendingConfirm {
  meetingId: string
  fileId: string
  size: number
}

export class UploadError extends Error {
  readonly step: UploadStep
  readonly code: string
  readonly status: number
  /** Set when only the confirm failed: retry that, never a new upload. */
  readonly resume: PendingConfirm | undefined

  constructor(step: UploadStep, code: string, status: number, resume?: PendingConfirm) {
    super(`${step}: ${code}`)
    this.name = 'UploadError'
    this.step = step
    this.code = code
    this.status = status
    this.resume = resume
  }
}

export interface UploadMeta {
  ext: string
  mimeType: string
  source: UploadSource
  durationSeconds: number | null
  startedAt: string
  /** PRF-07: a folder id, null for "no folder", undefined to let the API use the default. */
  folderId?: string | null | undefined
}

export interface UploadDeps {
  /** Authenticated request to the API (path relative to the API origin). */
  fetchApi: (path: string, init?: RequestInit) => Promise<Response>
  /** PUT the file to the Drive session; resolves to the Drive file id. */
  putFile: (url: string, blob: Blob, contentType: string, onProgress?: (fraction: number) => void) => Promise<string>
}

async function failure(step: UploadStep, res: Response): Promise<UploadError> {
  const body: unknown = await res.json().catch(() => null)
  const err = apiErrorFrom(res.status, body)
  return new UploadError(step, err.code, res.status)
}

function jsonPost(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

export async function uploadMeeting(
  deps: UploadDeps,
  blob: Blob,
  meta: UploadMeta,
  onProgress?: (fraction: number) => void,
): Promise<{ meetingId: string }> {
  let res: Response
  try {
    res = await deps.fetchApi(
      '/meetings',
      jsonPost({
        size: blob.size,
        fileExtension: meta.ext,
        mimeType: meta.mimeType,
        source: meta.source,
        durationSeconds: meta.durationSeconds,
        startedAt: meta.startedAt,
        ...(meta.folderId !== undefined ? { folderId: meta.folderId } : {}),
      }),
    )
  } catch {
    throw new UploadError('create', 'network', 0)
  }
  if (!res.ok) throw await failure('create', res)
  const created = (await res.json().catch(() => null)) as {
    meetingId?: unknown
    uploadUrl?: unknown
    contentType?: unknown
  } | null
  const meetingId = typeof created?.meetingId === 'string' ? created.meetingId : null
  if (!meetingId) throw new UploadError('create', 'bad_response', res.status)
  const discard = () => deps.fetchApi(`/meetings/${encodeURIComponent(meetingId)}`, { method: 'DELETE' }).catch(() => null)
  const uploadUrl = created?.uploadUrl
  const contentType = typeof created?.contentType === 'string' ? created.contentType : meta.mimeType
  if (typeof uploadUrl !== 'string' || !uploadUrl.startsWith(DRIVE_UPLOAD_PREFIX)) {
    await discard()
    throw new UploadError('create', 'bad_response', res.status)
  }

  let fileId: string
  try {
    fileId = await deps.putFile(uploadUrl, blob, contentType, onProgress)
  } catch (err) {
    await discard() // frees one of the user's 20 pending-upload slots
    throw err instanceof UploadError ? err : new UploadError('upload', 'network', 0)
  }

  return confirmMeetingUpload(deps, { meetingId, fileId, size: blob.size })
}

/** Step 3 alone; also the retry after a failed confirm (no second meeting, no second upload). */
export async function confirmMeetingUpload(
  deps: Pick<UploadDeps, 'fetchApi'>,
  pending: PendingConfirm,
  { retry = false }: { retry?: boolean } = {},
): Promise<{ meetingId: string }> {
  let confirm: Response
  try {
    confirm = await deps.fetchApi(
      `/meetings/${encodeURIComponent(pending.meetingId)}/uploaded`,
      jsonPost({ fileId: pending.fileId, size: pending.size }),
    )
  } catch {
    throw new UploadError('confirm', 'network', 0, pending)
  }
  // On a retry, 409 "already uploaded" means the first confirm went through and its answer was lost.
  if (retry && confirm.status === 409) return { meetingId: pending.meetingId }
  if (!confirm.ok) {
    const err = await failure('confirm', confirm)
    // 4xx = the API refused this file (it may have deleted the meeting): no retry of the confirm.
    const retryable = confirm.status >= 500 || confirm.status === 429 || confirm.status === 408
    throw new UploadError('confirm', err.code, err.status, retryable ? pending : undefined)
  }
  return { meetingId: pending.meetingId }
}

export const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024

/** Avatar (PRF-04): POST /profile/avatar → PUT to Drive → PATCH /profile confirms and saves it. */
export async function uploadAvatar(deps: UploadDeps, file: Blob, onProgress?: (fraction: number) => void): Promise<void> {
  if (!(AVATAR_TYPES as readonly string[]).includes(file.type)) throw new UploadError('create', 'type', 0)
  if (file.size <= 0 || file.size > MAX_AVATAR_BYTES) throw new UploadError('create', 'size', 0)
  let res: Response
  try {
    res = await deps.fetchApi('/profile/avatar', jsonPost({ contentType: file.type, size: file.size }))
  } catch {
    throw new UploadError('create', 'network', 0)
  }
  if (!res.ok) throw await failure('create', res)
  const body = (await res.json().catch(() => null)) as { uploadUrl?: unknown; avatarKey?: unknown } | null
  const uploadUrl = body?.uploadUrl
  const avatarKey = body?.avatarKey
  if (typeof uploadUrl !== 'string' || !uploadUrl.startsWith(DRIVE_UPLOAD_PREFIX) || typeof avatarKey !== 'string') {
    throw new UploadError('create', 'bad_response', res.status)
  }
  let fileId: string
  try {
    fileId = await deps.putFile(uploadUrl, file, file.type, onProgress)
  } catch (err) {
    throw err instanceof UploadError ? err : new UploadError('upload', 'network', 0)
  }
  let saved: Response
  try {
    saved = await deps.fetchApi('/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatar_key: avatarKey, avatar_file_id: fileId, avatar_size: file.size }),
    })
  } catch {
    throw new UploadError('confirm', 'network', 0)
  }
  if (!saved.ok) throw await failure('confirm', saved)
}

/** Drive answers the last PUT with the file resource (`fields=id`). */
export function parseDriveFileId(body: string): string | null {
  try {
    const id: unknown = (JSON.parse(body) as { id?: unknown }).id
    return typeof id === 'string' && FILE_ID.test(id) ? id : null
  } catch {
    return null
  }
}

/** Drive resumable status query: an empty PUT with `Content-Range: bytes *\/size`. */
export function sessionStatusRequest(size: number): { method: 'PUT'; headers: Record<string, string> } {
  return { method: 'PUT', headers: { 'Content-Range': `bytes */${size}` } }
}

/** The file id when a status answer says the upload is complete (200/201 + the file resource). */
export function finishedFileId(status: number, body: string): string | null {
  return status === 200 || status === 201 ? parseDriveFileId(body) : null
}

/** After a failed PUT: did Drive receive the whole file anyway? (Avoids an orphan Drive file whose
 * meeting we would otherwise delete.) Any doubt → null. */
async function askSession(url: string, size: number): Promise<string | null> {
  try {
    const res = await fetch(url, { ...sessionStatusRequest(size), credentials: 'omit' })
    return finishedFileId(res.status, await res.text())
  } catch {
    return null
  }
}

/** XHR PUT (fetch has no upload progress). No cookies, no Authorization: the URL is the credential. */
export function putToDrive(
  url: string,
  blob: Blob,
  contentType: string,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', contentType)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total)
    }
    const failed = (err: UploadError) => {
      void askSession(url, blob.size).then((id) => (id ? resolve(id) : reject(err)))
    }
    xhr.onload = () => {
      const id = xhr.status >= 200 && xhr.status < 300 ? parseDriveFileId(xhr.responseText) : null
      if (id) {
        onProgress?.(1)
        resolve(id)
      } else {
        failed(new UploadError('upload', `drive_${xhr.status}`, xhr.status))
      }
    }
    xhr.onerror = () => failed(new UploadError('upload', 'network', 0))
    xhr.onabort = () => reject(new UploadError('upload', 'aborted', 0))
    signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(blob)
  })
}

/** i18n key for an upload failure. Server text is never shown. */
export function uploadErrorKey(err: unknown): string {
  if (!(err instanceof UploadError)) return 'upload.errors.generic'
  if (err.code === 'network') return 'upload.errors.network'
  if (err.code === 'type' && err.status === 0) return 'upload.errors.avatarType'
  if (err.code === 'size' && err.status === 0) return 'upload.errors.avatarSize'
  if (err.code === 'aborted') return 'upload.errors.aborted'
  if (err.status === 429) return 'upload.errors.tooMany'
  if (err.status === 413 || (err.step === 'create' && err.status === 422)) return 'upload.errors.rejected'
  if (err.status === 503) return 'upload.errors.unavailable'
  if (err.step === 'upload') return 'upload.errors.drive'
  if (err.step === 'confirm') return 'upload.errors.confirm'
  return 'upload.errors.generic'
}
