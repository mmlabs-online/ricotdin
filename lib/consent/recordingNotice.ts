// Recording notice (COM-01) — pure constants and helpers. Imported by the recorder UI.
//
// Before a recording starts the user must acknowledge that every participant should know
// about and agree to the recording. The acknowledgement is kept per browser tab
// (sessionStorage) for RECORDING_NOTICE_TTL_MS, so the notice is shown regularly rather
// than remembered forever. Each acknowledgement is logged as the `recording_notice_ack`
// activity event (POST /api/activity), visible to admins at /admin/activity.

export const RECORDING_NOTICE_TTL_MS = 12 * 60 * 60 * 1000
export const RECORDING_NOTICE_STORAGE_KEY = 'ricotdin.recordingNoticeAckAt'

export const RECORDING_NOTICE_TEXT =
  'This app will record and transcribe the meeting. Everyone taking part should know about the recording and agree to it before you start.'

export const VERBAL_NOTICE_SCRIPT =
  "Before we begin: I'm going to record this meeting so I can transcribe it and take notes. Please let me know now if you don't want to be recorded."

/** True when a previous acknowledgement is still within the TTL (and not in the future). */
export function isNoticeAckFresh(ackedAtMs: number | null, nowMs: number): boolean {
  if (ackedAtMs === null) return false
  const age = nowMs - ackedAtMs
  return age >= 0 && age < RECORDING_NOTICE_TTL_MS
}

/** Parse the stored acknowledgement time; anything malformed means "not acknowledged". */
export function parseStoredAck(raw: string | null): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}
