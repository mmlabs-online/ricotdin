// Shared upload constraints — imported by both client and server code.
// Change MAX_UPLOAD_BYTES here to enforce a new limit everywhere at once.

/** Maximum file size for uploads (audio or video). Currently 1 GB. */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024

/** Audio-only file extensions (no video stream). */
export const ALLOWED_AUDIO_EXTENSIONS = [
  '.mp3',
  '.m4a',
  '.wav',
  '.aac',
  '.ogg',
  '.flac',
  '.webm',
] as const

/** Video file extensions — server extracts audio via ffmpeg before processing. */
export const ALLOWED_VIDEO_EXTENSIONS = [
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.m4v',
] as const

export type AllowedAudioExtension = (typeof ALLOWED_AUDIO_EXTENSIONS)[number]
export type AllowedVideoExtension = (typeof ALLOWED_VIDEO_EXTENSIONS)[number]

export function isAllowedExtension(ext: string): ext is AllowedAudioExtension {
  return (ALLOWED_AUDIO_EXTENSIONS as readonly string[]).includes(ext.toLowerCase())
}

export function isVideoExtension(ext: string): ext is AllowedVideoExtension {
  return (ALLOWED_VIDEO_EXTENSIONS as readonly string[]).includes(ext.toLowerCase())
}

export function isAnyAllowedExtension(ext: string): boolean {
  return isAllowedExtension(ext) || isVideoExtension(ext)
}
