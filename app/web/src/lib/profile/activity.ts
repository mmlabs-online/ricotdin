// The caller's own activity feed (PRF-09). Pure.

/** Every event GET /profile/activity accepts as `eventType` (app/domain/activity.py). */
export const ACTIVITY_TYPES = [
  'meeting_created', 'meeting_deleted', 'processing_done', 'processing_failed', 'record_start', 'record_stop',
  'recording_notice_ack', 'chat_message', 'folder_shared', 'folder_unshared',
] as const
export type ActivityType = (typeof ACTIVITY_TYPES)[number]

const PLAIN = new Set<string>(ACTIVITY_TYPES.filter((e) => e !== 'folder_shared' && e !== 'folder_unshared'))

/** i18n key for one row, read from the caller's side ("You shared …" / "… shared … with you"). */
export function activityKey(type: string, direction: 'in' | 'out', left: boolean): string {
  const base = 'profile.activity.events.'
  if (type === 'folder_shared') return `${base}folder_shared_${direction}`
  if (type === 'folder_unshared') return `${base}folder_${left ? 'left' : 'removed'}_${direction}`
  return base + (PLAIN.has(type) ? type : 'other')
}

// Order matters: Edge and Opera also say "Chrome", Chrome also says "Safari".
const BROWSERS: Array<[RegExp, string]> = [
  [/\bEdg(e|A|iOS)?\//, 'Edge'],
  [/\b(OPR|Opera)\//, 'Opera'],
  [/\b(Firefox|FxiOS)\//, 'Firefox'],
  [/\b(Chrome|CriOS|Chromium)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
]
const SYSTEMS: Array<[RegExp, string]> = [
  [/\biPad\b/, 'iPadOS'],
  [/\b(iPhone|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
]

/** "Chrome · macOS" from a user agent; only the parts it recognises; null when none. */
export function deviceLabel(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null
  const ua = userAgent.slice(0, 512)
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1]
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1]
  const parts = [browser, system].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

/** The first entry of each id, in order (offset pages can overlap when new rows arrive). */
export function uniqueById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>()
  return rows.filter((r) => !seen.has(r.id) && seen.add(r.id) !== undefined)
}
