// Meeting upload flow (ARC-12; v1 lib/upload/upload.ts adapted to Google Drive, CLAUDE.md §0.4/§0.6):
//   1. POST /meetings  → pending meeting + one-time Drive resumable session URL
//   2. PUT the file straight to Drive (browser → Google, with progress) → Drive file id
//   3. POST /meetings/{id}/uploaded {fileId, size} → the API verifies the file and queues processing
// The session URL is a bearer credential: never logged, never stored, only PUT to the Drive host.

import { apiErrorFrom } from '../../api/errors'
import type { UploadSource } from './rules'

export const DRIVE_UPLOAD_PREFIX = 'https://www.googleapis.com/upload/'
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/

export type UploadStep = 'create' | 'upload' | 'confirm'

export class UploadError extends Error {
  readonly step: UploadStep
  readonly code: string
  readonly status: number

  constructor(step: UploadStep, code: string, status: number) {
    super(`${step}: ${code}`)
    this.name = 'UploadError'
    this.step = step
    this.code = code
    this.status = status
  }
}

export interface UploadMeta {
  ext: string
  mimeType: string
  source: UploadSource
  durationSeconds: number | null
  startedAt: string
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

  let confirm: Response
  try {
    confirm = await deps.fetchApi(`/meetings/${encodeURIComponent(meetingId)}/uploaded`, jsonPost({ fileId, size: blob.size }))
  } catch {
    throw new UploadError('confirm', 'network', 0)
  }
  if (!confirm.ok) throw await failure('confirm', confirm)
  return { meetingId }
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
    xhr.onload = () => {
      const id = xhr.status >= 200 && xhr.status < 300 ? parseDriveFileId(xhr.responseText) : null
      if (id) {
        onProgress?.(1)
        resolve(id)
      } else {
        reject(new UploadError('upload', `drive_${xhr.status}`, xhr.status))
      }
    }
    xhr.onerror = () => reject(new UploadError('upload', 'network', 0))
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
