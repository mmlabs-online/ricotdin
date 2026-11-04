// Time helpers for playback, transcript and chat citations (ARC-12). Pure.

const MAX_SEEK_S = 6 * 3600 + 60 // recordings are at most 6 h (worker limit)

/** Link that opens a meeting at a time (chat citation → meeting). */
export function meetingSeekPath(meetingId: string, startMs: number): string {
  const s = Number.isFinite(startMs) && startMs > 0 ? Math.floor(startMs / 1000) : 0
  return `/meetings/${encodeURIComponent(meetingId)}?t=${s}`
}

/** `?t=<seconds>` → milliseconds, or null. */
export function parseSeekParam(search: string): number | null {
  const raw = new URLSearchParams(search).get('t')
  if (raw === null || !/^\d{1,6}$/.test(raw)) return null
  const s = Number(raw)
  return s <= MAX_SEEK_S ? s * 1000 : null
}

/** The transcript segment whose start is closest to a time (to scroll it into view). */
export function nearestSegment<T extends { start_ms: number }>(segments: readonly T[], ms: number): T | null {
  let best: T | null = null
  for (const seg of segments) {
    if (best === null || Math.abs(seg.start_ms - ms) < Math.abs(best.start_ms - ms)) best = seg
  }
  return best
}

/** Seconds → `mm:ss`, or `h:mm:ss` from one hour. */
export function formatClock(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** v1's `.ics` download name: the title slugged, else `event.ics`. */
export function icsFilename(title: string): string {
  const slug = title
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60)
  return `${slug || 'event'}.ics`
}
