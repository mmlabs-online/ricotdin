// Audio retention purge — pure logic (PRV-02). No I/O; tested in tests/retention.test.ts.
//
// Policy: when `app_config.storage.audio_retention_days` is a positive integer N, the audio
// file of every `done` meeting created more than N days ago is deleted from storage and
// `meetings.audio_path` is nulled (`audio_purged_at` set). Transcript, notes, todos and chat
// are always kept. Any unset / malformed value means "keep forever" — never delete when unsure.

export const RETENTION_SETTING_KEY = 'storage.audio_retention_days'
export const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Max meetings purged per run; the rest are picked up by the next daily run. */
export const PURGE_BATCH_LIMIT = 500
/** Upper bound (~10 years). Anything larger is treated as a typo → off. */
export const MAX_RETENTION_DAYS = 3650

const DAY_MS = 24 * 60 * 60 * 1000

/** Retention in whole days, or null = keep forever (purge off). */
export function parseRetentionDays(value: unknown): number | null {
  let n: number
  if (typeof value === 'number') {
    n = value
  } else if (typeof value === 'string') {
    const s = value.trim()
    if (!/^\d+$/.test(s)) return null
    n = Number(s)
  } else {
    return null
  }
  if (!Number.isInteger(n) || n < 1 || n > MAX_RETENTION_DAYS) return null
  return n
}

/** Meetings created strictly before this instant are past retention. */
export function retentionCutoff(nowMs: number, days: number): Date {
  return new Date(nowMs - days * DAY_MS)
}

export interface PurgeCandidate {
  status: string
  audio_path: string | null
  created_at: string
}

/** Only finished meetings that still have audio and are strictly older than the cutoff. */
export function isPurgeEligible(m: PurgeCandidate, cutoff: Date): boolean {
  if (m.status !== 'done') return false
  if (!m.audio_path) return false
  const created = Date.parse(m.created_at)
  if (Number.isNaN(created)) return false
  return created < cutoff.getTime()
}

/**
 * Reprocessing (POST /process, admin requeue) re-runs the pipeline from audio and first
 * wipes the transcript. Without audio that would destroy the meeting's results.
 */
export function canReprocess(m: { audio_path: string | null }): boolean {
  return Boolean(m.audio_path)
}

export type AudioState = 'available' | 'purged' | 'none'

export function audioState(m: { audio_path: string | null; audio_purged_at?: string | null }): AudioState {
  if (m.audio_path) return 'available'
  return m.audio_purged_at ? 'purged' : 'none'
}

/**
 * True only when `key` is THIS meeting's own audio object: `${userId}/${meetingId}` plus an
 * optional `.ext`. Users can UPDATE their meetings row under RLS, so service-role deletes must
 * not trust `audio_path` blindly — otherwise a forged path deletes another user's audio.
 */
export function isOwnedAudioKey(key: string, userId: string, meetingId: string): boolean {
  if (!key || !userId || !meetingId) return false
  const prefix = `${userId}/${meetingId}`
  if (!key.startsWith(prefix)) return false
  return /^(\.[A-Za-z0-9]{1,10})?$/.test(key.slice(prefix.length))
}
