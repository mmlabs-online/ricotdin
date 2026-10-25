// Unit tests for the per-user usage aggregation helpers used by the admin
// user-management table (Gemini tokens + Speechmatics audio-seconds per month).
//
// Pure, no I/O. Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { monthRange, aggregateUsageByUser, type UsageLogRow } from '../lib/admin/usageByUser.js'

const NOW = new Date('2026-06-23T12:00:00Z')

describe('monthRange', () => {
  it('parses a valid YYYY-MM into a UTC [start, end) range', () => {
    const r = monthRange('2026-06', NOW)
    assert.equal(r.month, '2026-06')
    assert.equal(r.startISO, '2026-06-01T00:00:00.000Z')
    assert.equal(r.endISO, '2026-07-01T00:00:00.000Z')
  })

  it('rolls December over to the next January', () => {
    const r = monthRange('2026-12', NOW)
    assert.equal(r.startISO, '2026-12-01T00:00:00.000Z')
    assert.equal(r.endISO, '2027-01-01T00:00:00.000Z')
  })

  it('falls back to the current month when missing', () => {
    const r = monthRange(null, NOW)
    assert.equal(r.month, '2026-06')
    assert.equal(r.startISO, '2026-06-01T00:00:00.000Z')
    assert.equal(r.endISO, '2026-07-01T00:00:00.000Z')
  })

  it('falls back to the current month when malformed or out of range', () => {
    assert.equal(monthRange('garbage', NOW).month, '2026-06')
    assert.equal(monthRange('2026-13', NOW).month, '2026-06') // month 13 invalid
    assert.equal(monthRange('2026-00', NOW).month, '2026-06') // month 0 invalid
    assert.equal(monthRange('', NOW).month, '2026-06')
  })

  it('pads single-digit months in the normalized value', () => {
    assert.equal(monthRange('2026-03', NOW).month, '2026-03')
  })
})

describe('aggregateUsageByUser', () => {
  const rows: UsageLogRow[] = [
    { user_id: 'u1', unit: 'tokens',        total_tokens: 1000, audio_seconds: null },
    { user_id: 'u1', unit: 'tokens',        total_tokens: 250,  audio_seconds: null },
    { user_id: 'u1', unit: 'audio_seconds', total_tokens: null, audio_seconds: 90 },
    { user_id: 'u2', unit: 'audio_seconds', total_tokens: null, audio_seconds: 30.5 },
    { user_id: null, unit: 'tokens',        total_tokens: 9999, audio_seconds: null }, // unattributed
  ]

  it('sums gemini tokens and audio-seconds separately per user', () => {
    const m = aggregateUsageByUser(rows)
    assert.deepEqual(m.get('u1'), { geminiTokens: 1250, audioSeconds: 90 })
    assert.deepEqual(m.get('u2'), { geminiTokens: 0, audioSeconds: 30.5 })
  })

  it('ignores rows with a null user_id', () => {
    const m = aggregateUsageByUser(rows)
    assert.equal(m.has('null'), false)
    assert.equal(m.size, 2)
  })

  it('never mixes token and audio units', () => {
    const m = aggregateUsageByUser([
      { user_id: 'x', unit: 'tokens',        total_tokens: 500, audio_seconds: 7 },
      { user_id: 'x', unit: 'audio_seconds', total_tokens: 12,  audio_seconds: 7 },
    ])
    // token row's stray audio_seconds is ignored; audio row's stray total_tokens is ignored
    assert.deepEqual(m.get('x'), { geminiTokens: 500, audioSeconds: 7 })
  })

  it('treats null numeric values as zero', () => {
    const m = aggregateUsageByUser([
      { user_id: 'y', unit: 'tokens',        total_tokens: null, audio_seconds: null },
      { user_id: 'y', unit: 'audio_seconds', total_tokens: null, audio_seconds: null },
    ])
    assert.deepEqual(m.get('y'), { geminiTokens: 0, audioSeconds: 0 })
  })

  it('returns an empty map for no rows', () => {
    assert.equal(aggregateUsageByUser([]).size, 0)
  })
})
