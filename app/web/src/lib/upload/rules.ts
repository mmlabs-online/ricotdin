// Upload rules shared by the record and upload flows (ARC-12). Same lists as the API
// (`app/api/app/domain/uploads.py`): checked here first so a bad file never starts an upload.

/** New uploads (owner decision 2026-11-04; the API enforces the same cap). */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024
/** The cap as shown to people. */
export const MAX_UPLOAD_LABEL = `${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`

export const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac', '.webm'] as const
export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.m4v'] as const

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

/** `accept` attribute for the file picker. */
export const ACCEPT = [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS].join(',')

export type UploadSource = 'recorded' | 'uploaded' | 'video'
export type FileCheck =
  | { ok: true; ext: string; source: UploadSource; mimeType: string }
  | { ok: false; error: 'type' | 'size' | 'empty'; ext: string }

export function fileExtension(name: string): string {
  const m = /(\.[^.]+)$/.exec(name)
  return m?.[1] ? m[1].toLowerCase() : ''
}

function baseType(mime: string): string {
  return mime.split(';')[0]?.trim().toLowerCase() ?? ''
}

/** The type sent to the API and Drive: the browser's own when it agrees with the extension. */
export function uploadMimeType(ext: string, browserType: string): string {
  const expected = MIME_BY_EXT[ext] ?? 'application/octet-stream'
  return browserType && baseType(browserType) === expected ? browserType : expected
}

export function checkUploadFile(name: string, size: number, browserType: string): FileCheck {
  const ext = fileExtension(name)
  if (!(ext in MIME_BY_EXT)) return { ok: false, error: 'type', ext }
  if (size <= 0) return { ok: false, error: 'empty', ext }
  if (size > MAX_UPLOAD_BYTES) return { ok: false, error: 'size', ext }
  const source: UploadSource = (VIDEO_EXTENSIONS as readonly string[]).includes(ext) ? 'video' : 'uploaded'
  return { ok: true, ext, source, mimeType: uploadMimeType(ext, browserType) }
}

/** Extension for a browser recording, from the MediaRecorder type. */
export function recordingExtension(mimeType: string): string {
  const base = baseType(mimeType)
  if (base === 'audio/ogg') return '.ogg'
  if (base === 'audio/mp4') return '.m4a'
  return '.webm'
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
