// Library-wide search (PRO-05). Pure.
import { meetingSeekPath } from '../media/seek'

export const MIN_QUERY = 2 // app/domain/search.py
export const MAX_QUERY = 200

export interface HighlightPart {
  text: string
  mark: boolean
}

/** `text` cut into plain and highlighted parts; bad, overlapping or out-of-order ranges are skipped. */
export function highlightParts(text: string, ranges: ReadonlyArray<readonly [number, number] | number[]>): HighlightPart[] {
  const clean = ranges
    .map((r) => [Number(r[0]), Number(r[1])] as const)
    .filter(([a, b]) => Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b > a && b <= text.length)
    .sort((x, y) => x[0] - y[0])
  const out: HighlightPart[] = []
  let at = 0
  for (const [a, b] of clean) {
    if (a < at) continue
    if (a > at) out.push({ text: text.slice(at, a), mark: false })
    out.push({ text: text.slice(a, b), mark: true })
    at = b
  }
  if (at < text.length || out.length === 0) out.push({ text: text.slice(at), mark: false })
  return out
}

/** Where a result opens: a transcript hit at its second, a summary / notes hit on the meeting. */
export function resultHref(meetingId: string, item: { kind: string; startMs: number | null }): string {
  if (item.kind === 'transcript' && item.startMs !== null) return meetingSeekPath(meetingId, item.startMs)
  return `/meetings/${encodeURIComponent(meetingId)}`
}

export function readSearchParams(search: string): { q: string; folder: string } {
  const p = new URLSearchParams(search)
  return { q: p.get('q') ?? '', folder: p.get('folder') ?? '' }
}

/** `/search?q=…&folder=…` (the Meetings page link carries what was typed). */
export function searchHref(q: string, folder = ''): string {
  const p = new URLSearchParams()
  if (q.trim()) p.set('q', q.trim())
  if (folder) p.set('folder', folder)
  const s = p.toString()
  return s ? `/search?${s}` : '/search'
}

export function validQuery(q: string): boolean {
  const n = q.trim().length
  return n >= MIN_QUERY && n <= MAX_QUERY
}
