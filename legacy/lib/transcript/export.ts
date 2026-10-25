// Pure transcript-export builders — no runtime dependencies, no I/O.
// Turns a meeting's transcript segments into a downloadable document in one of
// three formats: plain text (.txt), Markdown (.md), or SubRip subtitles (.srt).
//
// All functions are pure so they can be unit-tested without a browser or DOM.
// The calling UI is responsible for turning the returned string into a Blob and
// triggering the browser download.

import type { TranscriptSegment } from '@/types/database'

export type TranscriptFormat = 'txt' | 'md' | 'srt'

/** Minimal meeting shape needed for the document header. */
export interface TranscriptMeetingMeta {
  title: string
  created_at: string | null
}

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------

/** mm:ss for human-readable formats (e.g. 65_000 → "01:05"). */
export function formatClock(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  const totalSecs = Math.floor(safe / 1000)
  const m = Math.floor(totalSecs / 60).toString().padStart(2, '0')
  const s = (totalSecs % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

/** SRT timestamp: HH:MM:SS,mmm (comma before milliseconds, per the SubRip spec). */
export function formatSrtTime(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  const h = Math.floor(safe / 3_600_000)
  const m = Math.floor((safe % 3_600_000) / 60_000)
  const s = Math.floor((safe % 60_000) / 1000)
  const millis = Math.floor(safe % 1000)
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(millis, 3)}`
}

// ---------------------------------------------------------------------------
// Filename
// ---------------------------------------------------------------------------

/** Slugify a meeting title into a safe filename with the format's extension. */
export function transcriptFilename(title: string, format: TranscriptFormat): string {
  const slug =
    title
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 60) || 'transcript'
  return `${slug}-transcript.${format}`
}

// ---------------------------------------------------------------------------
// Format builders
// ---------------------------------------------------------------------------

function headerDate(created_at: string | null): string | null {
  if (!created_at) return null
  const d = new Date(created_at)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * Plain text: a header block, then one line per segment prefixed with a
 * timestamp range and speaker. Consecutive same-speaker turns are not merged —
 * every segment keeps its own timestamp so the file stays greppable.
 */
export function buildTxt(meeting: TranscriptMeetingMeta, segments: TranscriptSegment[]): string {
  const lines: string[] = []
  lines.push(meeting.title || 'Untitled meeting')
  const date = headerDate(meeting.created_at)
  if (date) lines.push(date)
  lines.push('='.repeat(60))
  lines.push('')

  for (const seg of segments) {
    const time = `[${formatClock(seg.start_ms)}–${formatClock(seg.end_ms)}]`
    const speaker = seg.speaker ? `${seg.speaker}: ` : ''
    lines.push(`${time} ${speaker}${seg.text}`.trimEnd())
  }

  return lines.join('\n')
}

/**
 * Markdown: an H1 title, an italic date line, then speaker-grouped blocks with
 * bold speaker labels and bracketed timestamps.
 */
export function buildMarkdown(meeting: TranscriptMeetingMeta, segments: TranscriptSegment[]): string {
  const lines: string[] = []
  lines.push(`# ${meeting.title || 'Untitled meeting'}`)
  const date = headerDate(meeting.created_at)
  if (date) lines.push(`*${date}*`)
  lines.push('')

  let lastSpeaker: string | null | undefined
  for (const seg of segments) {
    const speaker = seg.speaker ?? null
    if (speaker !== lastSpeaker) {
      lines.push('')
      lines.push(`**${speaker ?? 'Speaker'}**`)
      lastSpeaker = speaker
    }
    lines.push(`- \`${formatClock(seg.start_ms)}\` ${seg.text}`)
  }

  return lines.join('\n').trim() + '\n'
}

/** SubRip (.srt): numbered cues with HH:MM:SS,mmm --> HH:MM:SS,mmm ranges. */
export function buildSrt(_meeting: TranscriptMeetingMeta, segments: TranscriptSegment[]): string {
  const blocks: string[] = []
  segments.forEach((seg, i) => {
    const range = `${formatSrtTime(seg.start_ms)} --> ${formatSrtTime(seg.end_ms)}`
    const speaker = seg.speaker ? `${seg.speaker}: ` : ''
    blocks.push([`${i + 1}`, range, `${speaker}${seg.text}`].join('\n'))
  })
  return blocks.join('\n\n') + (blocks.length ? '\n' : '')
}

/** MIME type for the download Blob, per format. */
export function transcriptMime(format: TranscriptFormat): string {
  switch (format) {
    case 'md': return 'text/markdown;charset=utf-8'
    case 'srt': return 'application/x-subrip;charset=utf-8'
    case 'txt':
    default: return 'text/plain;charset=utf-8'
  }
}

/** Dispatch to the right builder for the requested format. */
export function buildTranscript(
  meeting: TranscriptMeetingMeta,
  segments: TranscriptSegment[],
  format: TranscriptFormat,
): string {
  switch (format) {
    case 'md': return buildMarkdown(meeting, segments)
    case 'srt': return buildSrt(meeting, segments)
    case 'txt':
    default: return buildTxt(meeting, segments)
  }
}
