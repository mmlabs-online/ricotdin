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
 * optional `.ext`. Users could UPDATE their meetings row under RLS until migration 033 (BUG-003),
 * and rows forged before it may remain, so service-role code must never trust `audio_path` blindly.
 */
export function isOwnedAudioKey(key: string, userId: string, meetingId: string): boolean {
  if (!key || !userId || !meetingId) return false
  const prefix = `${userId}/${meetingId}`
  if (!key.startsWith(prefix)) return false
  return /^(\.[A-Za-z0-9]{1,10})?$/.test(key.slice(prefix.length))
}

/**
 * The audio key to sign or download for a meeting, or null when there is none or it is not
 * this meeting's own object (BUG-003: a forged audio_path must never reach storage).
 */
export function ownedAudioPath(m: { id: string; user_id: string; audio_path: string | null }): string | null {
  if (!m.audio_path) return null
  return isOwnedAudioKey(m.audio_path, m.user_id, m.id) ? m.audio_path : null
}

/**
 * Storage objects to delete for a set of meetings: only each meeting's own key, each with its
 * own provider (BUG-004: a Supabase-only remove left R2 audio orphaned).
 */
export function ownedAudioDeleteItems(
  rows: Array<{ id: string; user_id: string; audio_path: string | null; storage_provider: string }>,
): Array<{ key: string; provider: string }> {
  const items: Array<{ key: string; provider: string }> = []
  for (const m of rows) {
    const key = ownedAudioPath(m)
    if (key) items.push({ key, provider: m.storage_provider })
  }
  return items
}

/**
 * Meetings a folder delete may remove: only the caller's own (BUG-011). Shared-folder editors can
 * place their own meetings in someone else's folder; those must never be deleted by the folder
 * owner — they fall back to Uncategorized via ON DELETE SET NULL when the folder goes.
 */
export function ownMeetingsOnly<T extends { user_id: string }>(rows: T[], callerId: string): T[] {
  if (!callerId) return []
  return rows.filter((m) => m.user_id === callerId)
}
