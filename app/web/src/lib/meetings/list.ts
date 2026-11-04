// Meeting list helpers (ARC-13a, MMG-01..03, PRP-07). Pure.

export interface MeetingRow {
  id: string
  user_id: string
  title: string
  status: string
  source: string
  duration_seconds: number | null
  pinned_at: string | null
  folder_id: string | null
  created_at: string
  error_message: string | null
}

const time = (iso: string | null): number => (iso ? Date.parse(iso) || 0 : 0)

/** Pinned first (most recently pinned on top), then newest first — the API order. */
export function sortMeetings<T extends MeetingRow>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => {
    if (a.pinned_at && b.pinned_at) return time(b.pinned_at) - time(a.pinned_at)
    if (a.pinned_at) return -1
    if (b.pinned_at) return 1
    return time(b.created_at) - time(a.created_at)
  })
}

/** Lowercase, without accents (so "dong bo" finds "Đồng bộ"). */
export function searchKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .trim()
}

export type FolderFilter = 'all' | 'none' | string

export function filterMeetings<T extends MeetingRow>(list: readonly T[], f: { search: string; folder: FolderFilter }): T[] {
  const q = searchKey(f.search)
  return list.filter((m) => {
    if (f.folder === 'none' && m.folder_id !== null) return false
    if (f.folder !== 'all' && f.folder !== 'none' && m.folder_id !== f.folder) return false
    return !q || searchKey(m.title).includes(q)
  })
}

export function withPin<T extends MeetingRow>(list: readonly T[], id: string, pinnedAt: string | null): T[] {
  return sortMeetings(list.map((m) => (m.id === id ? { ...m, pinned_at: pinnedAt } : m)))
}

export function withTitle<T extends MeetingRow>(list: readonly T[], id: string, title: string): T[] {
  return list.map((m) => (m.id === id ? { ...m, title } : m))
}

/** A `pending` meeting older than this is an abandoned upload (never confirmed): not worth polling. */
const PENDING_POLL_MS = 2 * 3600 * 1000

export function needsPolling(list: readonly MeetingRow[], now = Date.now()): boolean {
  return list.some(
    (m) => m.status === 'processing' || (m.status === 'pending' && now - time(m.created_at) < PENDING_POLL_MS),
  )
}

export function statusKind(status: string): 'success' | 'processing' | 'danger' {
  if (status === 'done') return 'success'
  if (status === 'failed') return 'danger'
  return 'processing'
}

/** Whole minutes (at least 1) split into hours + minutes; null when unknown. */
export function durationParts(seconds: number | null): { hours: number; minutes: number } | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null
  const total = Math.max(1, Math.round(seconds / 60))
  return { hours: Math.floor(total / 60), minutes: total % 60 }
}
