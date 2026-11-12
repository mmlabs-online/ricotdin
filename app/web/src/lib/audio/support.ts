// Browser capability checks for recording (ported from v1 for ARC-12). Browser only.

const PREFERRED_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'] as const

/** Best supported recording type, or '' if none. */
export function getSupportedMimeType(): string {
  if (typeof window === 'undefined' || !('MediaRecorder' in window)) return ''
  for (const type of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return ''
}

/** What this browser lacks for recording, as i18n keys (empty = supported). Reliable tab audio
 * is Chromium-only; Firefox/Safari silently drop it — that is reported after capture instead. */
export function missingRecordingCapabilities(): string[] {
  if (typeof window === 'undefined') return ['record.missing.browser']
  const missing: string[] = []
  if (!navigator.mediaDevices?.getDisplayMedia) missing.push('record.missing.display')
  if (!navigator.mediaDevices?.getUserMedia) missing.push('record.missing.mic')
  if (!('MediaRecorder' in window)) missing.push('record.missing.recorder')
  else if (!getSupportedMimeType()) missing.push('record.missing.codec')
  return missing
}

/** i18n key for a capture error (the browser's own message is never shown). */
export function recorderErrorKey(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  switch (name) {
    case 'NotAllowedError':
      return 'record.errors.denied'
    case 'NotFoundError':
      return 'record.errors.noMic'
    case 'AbortError':
      return 'record.errors.cancelled'
    case 'InvalidStateError':
      return 'record.errors.state'
    default:
      return 'record.errors.generic'
  }
}
