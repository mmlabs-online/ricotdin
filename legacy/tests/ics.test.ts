// Unit tests for lib/ics/index.ts
// Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  escapeIcsText,
  foldIcsLine,
  formatIcsDate,
  buildIcs,
  buildSuggestionIcs,
  DEFAULT_DURATION_MINUTES,
} from '../lib/ics/index.js'

// Fixed timestamps for deterministic output
const FIXED_DTSTAMP = new Date('2026-06-10T00:00:00Z')
const FIXED_DTSTART = new Date('2026-06-15T10:00:00Z')

// ---------------------------------------------------------------------------
// escapeIcsText
// ---------------------------------------------------------------------------

describe('escapeIcsText', () => {
  it('escapes commas', () => {
    assert.equal(escapeIcsText('a,b'), 'a\\,b')
  })

  it('escapes semicolons', () => {
    assert.equal(escapeIcsText('a;b'), 'a\\;b')
  })

  it('escapes backslashes', () => {
    assert.equal(escapeIcsText('a\\b'), 'a\\\\b')
  })

  it('escapes LF newlines', () => {
    assert.equal(escapeIcsText('a\nb'), 'a\\nb')
  })

  it('escapes CRLF newlines', () => {
    assert.equal(escapeIcsText('a\r\nb'), 'a\\nb')
  })

  it('escapes CR-only newlines', () => {
    assert.equal(escapeIcsText('a\rb'), 'a\\nb')
  })

  it('does not escape colons (not required by RFC 5545)', () => {
    assert.equal(escapeIcsText('a:b'), 'a:b')
  })

  it('does not escape double-quotes', () => {
    assert.equal(escapeIcsText('"hello"'), '"hello"')
  })

  it('handles empty string', () => {
    assert.equal(escapeIcsText(''), '')
  })
})

// ---------------------------------------------------------------------------
// foldIcsLine
// ---------------------------------------------------------------------------

describe('foldIcsLine', () => {
  it('returns short lines unchanged', () => {
    const line = 'SUMMARY:Hello'
    assert.equal(foldIcsLine(line), line)
  })

  it('returns exactly 75-char lines unchanged', () => {
    const line = 'A'.repeat(75)
    assert.equal(foldIcsLine(line), line)
  })

  it('folds lines longer than 75 chars', () => {
    const line = 'DESCRIPTION:' + 'A'.repeat(80)
    const folded = foldIcsLine(line)
    const parts = folded.split('\r\n')
    assert.equal(parts.length, 2)
    assert.equal(parts[0].length, 75)
    assert.ok(parts[1].startsWith(' '), 'continuation line must start with a space')
  })

  it('continuation lines are at most 75 chars', () => {
    // A very long line should fold into multiple parts each ≤ 75 chars
    const line = 'DESCRIPTION:' + 'X'.repeat(300)
    const folded = foldIcsLine(line)
    const parts = folded.split('\r\n')
    for (const part of parts) {
      assert.ok(part.length <= 75, `line too long: ${part.length} chars`)
    }
  })

  it('reassembled content matches original after unfolding', () => {
    const line = 'DESCRIPTION:' + 'B'.repeat(200)
    const folded = foldIcsLine(line)
    // Unfold: remove CRLF + SPACE
    const unfolded = folded.split('\r\n').map((p, i) => (i === 0 ? p : p.slice(1))).join('')
    assert.equal(unfolded, line)
  })
})

// ---------------------------------------------------------------------------
// formatIcsDate
// ---------------------------------------------------------------------------

describe('formatIcsDate', () => {
  it('formats a UTC date correctly', () => {
    assert.equal(formatIcsDate(new Date('2026-06-15T10:30:45Z')), '20260615T103045Z')
  })

  it('pads single-digit month, day, hour, minute, second', () => {
    assert.equal(formatIcsDate(new Date('2026-01-05T09:03:07Z')), '20260105T090307Z')
  })

  it('always uses UTC regardless of local timezone', () => {
    // Create a date that is midnight UTC (should not be affected by local tz)
    const d = new Date('2026-03-01T00:00:00Z')
    assert.equal(formatIcsDate(d), '20260301T000000Z')
  })
})

// ---------------------------------------------------------------------------
// buildIcs
// ---------------------------------------------------------------------------

describe('buildIcs', () => {
  function make(overrides: Partial<Parameters<typeof buildIcs>[0]> = {}) {
    return buildIcs({
      uid: 'test-uid@ricotdin',
      summary: 'Team Sync',
      dtstart: FIXED_DTSTART,
      dtstamp: FIXED_DTSTAMP,
      ...overrides,
    })
  }

  it('contains required VCALENDAR structure', () => {
    const result = make()
    assert.ok(result.includes('BEGIN:VCALENDAR'))
    assert.ok(result.includes('BEGIN:VEVENT'))
    assert.ok(result.includes('END:VEVENT'))
    assert.ok(result.includes('END:VCALENDAR'))
  })

  it('uses CRLF line endings throughout', () => {
    const result = make()
    // Every line break should be CRLF, no bare LF
    const linesLf = result.split('\n').length
    const linesCrlf = result.split('\r\n').length
    assert.equal(linesLf, linesCrlf, 'every LF should be preceded by CR')
  })

  it('DTSTART matches the input date', () => {
    const result = make()
    assert.ok(result.includes('DTSTART:20260615T100000Z'))
  })

  it('DTSTAMP matches the stamp date', () => {
    const result = make()
    assert.ok(result.includes('DTSTAMP:20260610T000000Z'))
  })

  it('SUMMARY contains the event title', () => {
    const result = make({ summary: 'Q3 Planning' })
    assert.ok(result.includes('SUMMARY:Q3 Planning'))
  })

  it('SUMMARY is escaped', () => {
    const result = make({ summary: 'A, B; C' })
    assert.ok(result.includes('SUMMARY:A\\, B\\; C'))
  })

  it('uses default 60-min duration', () => {
    const result = make()
    assert.ok(result.includes('DURATION:PT60M'))
    assert.equal(DEFAULT_DURATION_MINUTES, 60)
  })

  it('respects custom durationMinutes', () => {
    const result = make({ durationMinutes: 30 })
    assert.ok(result.includes('DURATION:PT30M'))
  })

  it('includes DESCRIPTION when provided', () => {
    const result = make({ description: 'Some notes here' })
    assert.ok(result.includes('DESCRIPTION:Some notes here'))
  })

  it('omits DESCRIPTION when not provided', () => {
    const result = make()
    assert.ok(!result.includes('DESCRIPTION:'))
  })

  it('UID contains the provided uid', () => {
    const result = make({ uid: 'abc-123@ricotdin' })
    assert.ok(result.includes('UID:abc-123@ricotdin'))
  })

  it('ends with a trailing CRLF', () => {
    const result = make()
    assert.ok(result.endsWith('\r\n'))
  })
})

// ---------------------------------------------------------------------------
// buildSuggestionIcs
// ---------------------------------------------------------------------------

describe('buildSuggestionIcs', () => {
  const baseSuggestion = {
    id: 'sug-abc-123',
    title: 'Quarterly Review',
    proposed_at: '2026-06-20T14:00:00Z',
    raw_mention: 'let\'s do the quarterly review next Friday',
  }

  it('produces a valid VCALENDAR from a suggestion row', () => {
    const result = buildSuggestionIcs(baseSuggestion, FIXED_DTSTAMP)
    assert.ok(result.includes('BEGIN:VCALENDAR'))
    assert.ok(result.includes('BEGIN:VEVENT'))
    assert.ok(result.includes('SUMMARY:Quarterly Review'))
  })

  it('UID is based on the suggestion id', () => {
    const result = buildSuggestionIcs(baseSuggestion, FIXED_DTSTAMP)
    assert.ok(result.includes('UID:sug-abc-123@ricotdin'))
  })

  it('DTSTART matches proposed_at', () => {
    const result = buildSuggestionIcs(baseSuggestion, FIXED_DTSTAMP)
    assert.ok(result.includes('DTSTART:20260620T140000Z'))
  })

  it('DESCRIPTION includes raw_mention', () => {
    const result = buildSuggestionIcs(baseSuggestion, FIXED_DTSTAMP)
    assert.ok(result.includes('Mentioned in meeting'))
    // Use a substring short enough to fit within a single fold unit (≤75 chars
    // from the start of the DESCRIPTION line), avoiding fold-boundary splits.
    assert.ok(result.includes('quarterly review'))
  })

  it('DESCRIPTION always includes the auto-detected note', () => {
    const result = buildSuggestionIcs(baseSuggestion, FIXED_DTSTAMP)
    assert.ok(result.includes('Auto-detected from meeting transcript'))
  })

  it('throws when proposed_at is null', () => {
    const noTime = { ...baseSuggestion, proposed_at: null }
    assert.throws(
      () => buildSuggestionIcs(noTime, FIXED_DTSTAMP),
      { message: /no proposed_at/ },
    )
  })

  it('throws when proposed_at is an invalid date string', () => {
    const invalid = { ...baseSuggestion, proposed_at: 'not-a-date' }
    assert.throws(
      () => buildSuggestionIcs(invalid, FIXED_DTSTAMP),
      { message: /invalid proposed_at/ },
    )
  })

  it('works when raw_mention is null (omits that line from description)', () => {
    const noMention = { ...baseSuggestion, raw_mention: null }
    const result = buildSuggestionIcs(noMention, FIXED_DTSTAMP)
    assert.ok(!result.includes('Mentioned in meeting'))
    assert.ok(result.includes('Auto-detected from meeting transcript'))
  })
})
