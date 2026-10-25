// Browser capability detection for audio recording.
// All functions are safe to call only in the browser — do not import this
// module from server components.

const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
] as const

/** Returns the best supported audio mime type, or '' if none found. */
export function getSupportedMimeType(): string {
  if (typeof window === 'undefined' || !('MediaRecorder' in window)) return ''
  for (const type of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return ''
}

export interface SupportCheck {
  supported: boolean
  missingCapabilities: string[]
}

/**
 * Returns whether the browser has every capability we need, plus a list of
 * what is missing (for display in unsupported-browser banners).
 *
 * Reliable display-audio capture is only available on Chromium (Chrome/Edge).
 * Firefox and Safari silently drop the audio track — we surface that as a
 * runtime warning after capture, not here.
 */
export function checkRecordingSupport(): SupportCheck {
  if (typeof window === 'undefined') return { supported: false, missingCapabilities: [] }

  const missing: string[] = []

  if (!navigator.mediaDevices?.getDisplayMedia) {
    missing.push('getDisplayMedia (screen/tab capture)')
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    missing.push('getUserMedia (microphone access)')
  }
  if (!('MediaRecorder' in window)) {
    missing.push('MediaRecorder API')
  } else if (!getSupportedMimeType()) {
    missing.push('supported audio recording codec (webm/ogg/mp4)')
  }

  return { supported: missing.length === 0, missingCapabilities: missing }
}

export function isRecordingSupported(): boolean {
  return checkRecordingSupport().supported
}

export interface GrantedTracks {
  hasMic: boolean
  hasDisplayAudio: boolean
  hasDisplayVideo: boolean
}

/**
 * After capture, inspect which tracks were actually granted.
 * hasDisplayAudio will be false when the user shared a screen/window but did
 * NOT tick "Share audio" — that is the most common failure mode and the UI
 * should warn loudly.
 */
export function getGrantedTracks(
  micStream: MediaStream,
  displayStream: MediaStream,
): GrantedTracks {
  return {
    hasMic: micStream.getAudioTracks().length > 0,
    hasDisplayAudio: displayStream.getAudioTracks().length > 0,
    hasDisplayVideo: displayStream.getVideoTracks().length > 0,
  }
}
