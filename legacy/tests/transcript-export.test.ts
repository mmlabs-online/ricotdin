// Unit tests for lib/transcript/export.ts
// Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatClock,
  formatSrtTime,
  transcriptFilename,
  transcriptMime,
  buildTxt,
  buildMarkdown,
  buildSrt,
  buildTranscript,
} from '../lib/transcript/export.js'
import type { TranscriptSegment } from '../types/database.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function seg(partial: Partial<TranscriptSegment> & Pick<TranscriptSegment, 'segment_index' | 'start_ms' | 'end_ms' | 'text'>): TranscriptSegment {
  return {
    id: `seg-${partial.segment_index}`,
    meeting_id: 'm1',
    speaker: null,
    confidence: null,
    created_at: '2026-01-01T00:00:00Z',
    ...partial,
  }
}

const MEETING = { title: 'Weekly Sync', created_at: '2026-07-22T09:30:00Z' }

const SEGMENTS: TranscriptSegment[] = [
  seg({ segment_index: 0, start_ms: 0, end_ms: 5_000, text: 'Hello everyone.', speaker: 'Alice' }),
  seg({ segment_index: 1, start_ms: 5_000, end_ms: 9_000, text: 'Lets get started.', speaker: 'Alice' }),
  seg({ segment_index: 2, start_ms: 65_000, end_ms: 70_000, text: 'Sounds good.', speaker: 'Bob' }),
]

// ---------------------------------------------------------------------------
// formatClock
// ---------------------------------------------------------------------------

describe('formatClock', () => {
  it('formats zero', () => assert.equal(formatClock(0), '00:00'))
  it('formats seconds', () => assert.equal(formatClock(5_000), '00:05'))
  it('formats minutes and seconds', () => assert.equal(formatClock(65_000), '01:05'))
  it('floors sub-second remainders', () => assert.equal(formatClock(65_999), '01:05'))
  it('clamps negative and NaN to zero', () => {
    assert.equal(formatClock(-100), '00:00')
    assert.equal(formatClock(NaN), '00:00')
  })
})

// ---------------------------------------------------------------------------
// formatSrtTime
// ---------------------------------------------------------------------------

describe('formatSrtTime', () => {
  it('formats zero', () => assert.equal(formatSrtTime(0), '00:00:00,000'))
  it('formats milliseconds with comma separator', () => assert.equal(formatSrtTime(1_234), '00:00:01,234'))
  it('formats hours', () => assert.equal(formatSrtTime(3_661_500), '01:01:01,500'))
  it('clamps negatives to zero', () => assert.equal(formatSrtTime(-5), '00:00:00,000'))
})

// ---------------------------------------------------------------------------
// transcriptFilename
// ---------------------------------------------------------------------------

describe('transcriptFilename', () => {
  it('slugifies title and appends extension', () => {
    assert.equal(transcriptFilename('Weekly Sync', 'txt'), 'weekly-sync-transcript.txt')
  })
  it('collapses non-alphanumerics and trims dashes', () => {
    assert.equal(transcriptFilename('  Q3 — Planning!! ', 'md'), 'q3-planning-transcript.md')
  })
  it('falls back to "transcript" for an empty slug', () => {
    assert.equal(transcriptFilename('!!!', 'srt'), 'transcript-transcript.srt')
  })
})

// ---------------------------------------------------------------------------
// transcriptMime
// ---------------------------------------------------------------------------

describe('transcriptMime', () => {
  it('maps each format', () => {
    assert.match(transcriptMime('txt'), /text\/plain/)
    assert.match(transcriptMime('md'), /text\/markdown/)
    assert.match(transcriptMime('srt'), /x-subrip/)
  })
})

// ---------------------------------------------------------------------------
// buildTxt
// ---------------------------------------------------------------------------

describe('buildTxt', () => {
  it('includes a header with title and ISO date', () => {
    const out = buildTxt(MEETING, SEGMENTS)
    assert.ok(out.startsWith('Weekly Sync\n'))
    assert.ok(out.includes('2026-07-22T09:30:00.000Z'))
  })

  it('emits one timestamped line per segment with speaker', () => {
    const out = buildTxt(MEETING, SEGMENTS)
    assert.ok(out.includes('[00:00–00:05] Alice: Hello everyone.'))
    assert.ok(out.includes('[01:05–01:10] Bob: Sounds good.'))
  })

  it('omits the speaker prefix when speaker is null', () => {
    const out = buildTxt(MEETING, [seg({ segment_index: 0, start_ms: 0, end_ms: 1_000, text: 'No speaker.' })])
    assert.ok(out.includes('[00:00–00:01] No speaker.'))
    assert.ok(!out.includes(': No speaker.'))
  })

  it('handles a missing date gracefully', () => {
    const out = buildTxt({ title: 'X', created_at: null }, SEGMENTS)
    assert.ok(out.startsWith('X\n'))
    assert.ok(!out.includes('null'))
  })

  it('falls back to a default title', () => {
    const out = buildTxt({ title: '', created_at: null }, [])
    assert.ok(out.startsWith('Untitled meeting'))
  })
})

// ---------------------------------------------------------------------------
// buildMarkdown
// ---------------------------------------------------------------------------

describe('buildMarkdown', () => {
  it('renders an H1 title and italic date', () => {
    const out = buildMarkdown(MEETING, SEGMENTS)
    assert.ok(out.includes('# Weekly Sync'))
    assert.ok(out.includes('*2026-07-22T09:30:00.000Z*'))
  })

  it('groups consecutive same-speaker turns under one bold label', () => {
    const out = buildMarkdown(MEETING, SEGMENTS)
    assert.equal(out.match(/\*\*Alice\*\*/g)?.length, 1)
    assert.equal(out.match(/\*\*Bob\*\*/g)?.length, 1)
  })

  it('lists each segment with a code-formatted timestamp', () => {
    const out = buildMarkdown(MEETING, SEGMENTS)
    assert.ok(out.includes('- `00:00` Hello everyone.'))
    assert.ok(out.includes('- `01:05` Sounds good.'))
  })

  it('uses "Speaker" placeholder for null speaker', () => {
    const out = buildMarkdown(MEETING, [seg({ segment_index: 0, start_ms: 0, end_ms: 1_000, text: 'Anon.' })])
    assert.ok(out.includes('**Speaker**'))
  })
})

// ---------------------------------------------------------------------------
// buildSrt
// ---------------------------------------------------------------------------

describe('buildSrt', () => {
  it('numbers cues starting at 1', () => {
    const out = buildSrt(MEETING, SEGMENTS)
    assert.ok(out.startsWith('1\n'))
    assert.ok(out.includes('\n3\n'))
  })

  it('emits SRT time ranges', () => {
    const out = buildSrt(MEETING, SEGMENTS)
    assert.ok(out.includes('00:00:00,000 --> 00:00:05,000'))
    assert.ok(out.includes('00:01:05,000 --> 00:01:10,000'))
  })

  it('includes speaker prefix in cue text', () => {
    const out = buildSrt(MEETING, SEGMENTS)
    assert.ok(out.includes('Alice: Hello everyone.'))
  })

  it('returns an empty string for no segments', () => {
    assert.equal(buildSrt(MEETING, []), '')
  })
})

// ---------------------------------------------------------------------------
// buildTranscript dispatch
// ---------------------------------------------------------------------------

describe('buildTranscript', () => {
  it('dispatches to txt', () => {
    assert.equal(buildTranscript(MEETING, SEGMENTS, 'txt'), buildTxt(MEETING, SEGMENTS))
  })
  it('dispatches to md', () => {
    assert.equal(buildTranscript(MEETING, SEGMENTS, 'md'), buildMarkdown(MEETING, SEGMENTS))
  })
  it('dispatches to srt', () => {
    assert.equal(buildTranscript(MEETING, SEGMENTS, 'srt'), buildSrt(MEETING, SEGMENTS))
  })
})
