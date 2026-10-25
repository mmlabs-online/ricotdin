// Pure iCalendar (RFC 5545) builder — no runtime dependencies.
// Produces a VCALENDAR containing a single VEVENT suitable for import into
// Google Calendar, Apple Calendar, Outlook, and any standards-compliant client.
//
// Design decisions:
// - All times are emitted as UTC (Z suffix) so behaviour is timezone-agnostic.
// - proposed_at === null → caller should not call buildSuggestionIcs; a clear
//   error is thrown if they do. Never fabricate a datetime.
// - Lines are folded at 75 octets per RFC 5545 §3.1.
// - Text values are escaped per RFC 5545 §3.3.11 (\, \; \n \\).

import type { CalendarSuggestion } from '@/types/database'

export const DEFAULT_DURATION_MINUTES = 60 // One hour; Gemini doesn't know end times

const CRLF = '\r\n'
const FOLD_AT = 75 // RFC 5545 §3.1: fold before 75 octets

// ---------------------------------------------------------------------------
// Low-level helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Escape a TEXT property value per RFC 5545 §3.3.11.
 * Required escapes: backslash, comma, semicolon, newlines.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\r\n|\r|\n/g, '\\n')
}

/**
 * Fold a content line so no single line exceeds 75 octets (RFC 5545 §3.1).
 * For ASCII content (our case), octets === characters.
 * Continuation lines begin with a single SPACE.
 */
export function foldIcsLine(line: string): string {
  if (line.length <= FOLD_AT) return line
  const parts: string[] = []
  let pos = 0
  let first = true
  while (pos < line.length) {
    // First chunk: up to 75 chars. Continuation chunks: 74 chars (the leading
    // space added by the fold join counts as the 75th).
    const limit = first ? FOLD_AT : FOLD_AT - 1
    parts.push(line.slice(pos, pos + limit))
    pos += limit
    first = false
  }
  return parts.join(CRLF + ' ')
}

/**
 * Format a Date as a UTC basic iCalendar datetime: YYYYMMDDTHHMMSSZ
 */
export function formatIcsDate(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return (
    date.getUTCFullYear().toString() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    'T' +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z'
  )
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

export type IcsEventInput = {
  /** Stable identifier for the event; should be globally unique (e.g. uuid@host). */
  uid: string
  /** Event title / SUMMARY property. */
  summary: string
  /** Start time of the event (emitted as UTC). */
  dtstart: Date
  /**
   * Timestamp of when this iCalendar object was created.
   * Pass a fixed value in tests for deterministic output.
   */
  dtstamp: Date
  /** Duration in minutes (defaults to DEFAULT_DURATION_MINUTES = 60). */
  durationMinutes?: number
  /** Optional event description (raw text, will be escaped). */
  description?: string
}

/**
 * Build a VCALENDAR string with a single VEVENT.
 * Returns a string with CRLF line endings as required by RFC 5545.
 */
export function buildIcs(input: IcsEventInput): string {
  const duration = input.durationMinutes ?? DEFAULT_DURATION_MINUTES

  const properties: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ricotdin//Meeting Assistant//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    `DTSTAMP:${formatIcsDate(input.dtstamp)}`,
    `DTSTART:${formatIcsDate(input.dtstart)}`,
    `DURATION:PT${duration}M`,
    `SUMMARY:${escapeIcsText(input.summary)}`,
  ]

  if (input.description) {
    properties.push(`DESCRIPTION:${escapeIcsText(input.description)}`)
  }

  properties.push('END:VEVENT', 'END:VCALENDAR')

  return properties.map(foldIcsLine).join(CRLF) + CRLF
}

// ---------------------------------------------------------------------------
// Convenience wrapper for CalendarSuggestion rows
// ---------------------------------------------------------------------------

/**
 * Build a VCALENDAR from a `calendar_suggestions` DB row.
 *
 * Throws if `suggestion.proposed_at` is null — never fabricate a datetime.
 * The caller (route handler) is responsible for returning a 422 in that case
 * so the UI can show "no time detected" rather than an error.
 *
 * @param suggestion  The DB row (or a compatible shape).
 * @param dtstamp     Timestamp for the DTSTAMP property; defaults to now.
 */
export function buildSuggestionIcs(
  suggestion: Pick<CalendarSuggestion, 'id' | 'title' | 'proposed_at' | 'raw_mention'>,
  dtstamp: Date = new Date(),
): string {
  if (!suggestion.proposed_at) {
    throw new Error(
      `buildSuggestionIcs: suggestion ${suggestion.id} has no proposed_at — ` +
        'cannot generate ICS without a specific time.',
    )
  }

  const dtstart = new Date(suggestion.proposed_at)
  if (isNaN(dtstart.getTime())) {
    throw new Error(
      `buildSuggestionIcs: invalid proposed_at value "${suggestion.proposed_at}" for suggestion ${suggestion.id}`,
    )
  }

  const descriptionParts: string[] = []
  if (suggestion.raw_mention) {
    descriptionParts.push(`Mentioned in meeting: "${suggestion.raw_mention}"`)
  }
  descriptionParts.push('Auto-detected from meeting transcript.')

  return buildIcs({
    uid: `${suggestion.id}@ricotdin`,
    summary: suggestion.title,
    dtstart,
    dtstamp,
    description: descriptionParts.join('\n'),
  })
}
