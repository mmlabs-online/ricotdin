// Recording notice (COM-01, ported for ARC-12). Before a recording starts the user must
// acknowledge that every participant should know about and agree to it. The acknowledgement is
// kept per tab (sessionStorage) for RECORDING_NOTICE_TTL_MS, so the notice is shown regularly.
// Each acknowledgement is logged as the `recording_notice_ack` activity event (best effort).
// The notice text lives in the i18n files (`record.notice.*`).

export const RECORDING_NOTICE_TTL_MS = 12 * 60 * 60 * 1000
export const RECORDING_NOTICE_STORAGE_KEY = 'ricotdin.recordingNoticeAckAt'

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

/** Storage blocked or anything odd → not acknowledged (the notice shows). */
export function isNoticeAcknowledged(now = Date.now()): boolean {
  try {
    return isNoticeAckFresh(parseStoredAck(sessionStorage.getItem(RECORDING_NOTICE_STORAGE_KEY)), now)
  } catch {
    return false
  }
}

export function storeNoticeAcknowledged(now = Date.now()): void {
  try {
    sessionStorage.setItem(RECORDING_NOTICE_STORAGE_KEY, String(now))
  } catch {
    // storage blocked: the notice shows again next time
  }
}
