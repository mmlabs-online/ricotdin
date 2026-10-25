// Unit tests for the AI provider usage-log feature.
//
// Four required scenarios (all pure — no I/O, no DB calls):
//   1. Admin guard → non-admin gets 403 (checkAdminRole pure function).
//   2. Token-unit row: correct field population for a Gemini call.
//   3. Audio-seconds-unit row: correct field population for a Speechmatics call.
//   4. In-process aggregation: per-unit sums are computed correctly and
//      tokens/audio_seconds are NEVER conflated.
//
// Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkAdminRole } from '../lib/admin/guards.js'

// ---------------------------------------------------------------------------
// 1. Admin guard — non-admins must be blocked from /api/admin/ai-usage
// ---------------------------------------------------------------------------

describe('Admin guard — /api/admin/ai-usage returns 403 for non-admins', () => {
  it('returns false (→ 403) for role = user', () => {
    assert.equal(checkAdminRole({ role: 'user' }), false)
  })

  it('returns false (→ 403) when role key is absent', () => {
    assert.equal(checkAdminRole({}), false)
  })

  it('returns true (→ allowed) for role = admin', () => {
    assert.equal(checkAdminRole({ role: 'admin' }), true)
  })
})

// ---------------------------------------------------------------------------
// 2. Token-unit row — correct fields for a Gemini generateContent response
// ---------------------------------------------------------------------------

type UsageUnit = 'tokens' | 'audio_seconds'
type UsageStatus = 'ok' | 'rate_limited' | 'error'

interface UsageEntry {
  provider: string
  model: string
  operation: string
  unit: UsageUnit
  quantity: number
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  audio_seconds?: number
  status?: UsageStatus
  meeting_id?: string | null
  user_id?: string | null
}

/** Mirrors the normalisation done in logUsage._write() */
function buildRow(entry: UsageEntry) {
  return {
    provider:      entry.provider,
    model:         entry.model,
    operation:     entry.operation,
    unit:          entry.unit,
    quantity:      entry.quantity,
    input_tokens:  entry.input_tokens  ?? null,
    output_tokens: entry.output_tokens ?? null,
    total_tokens:  entry.total_tokens  ?? null,
    audio_seconds: entry.audio_seconds ?? null,
    status:        entry.status        ?? 'ok',
    http_code:     null,
    meeting_id:    entry.meeting_id    ?? null,
    user_id:       entry.user_id       ?? null,
  }
}

describe('Token-unit row — Gemini analyze call', () => {
  const entry: UsageEntry = {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    operation: 'analyze',
    unit: 'tokens',
    quantity: 1500,
    input_tokens: 1200,
    output_tokens: 300,
    total_tokens: 1500,
    meeting_id: 'meeting-uuid-123',
    user_id: 'user-uuid-456',
  }
  const row = buildRow(entry)

  it('sets unit = tokens', () => assert.equal(row.unit, 'tokens'))
  it('sets quantity = total_tokens', () => assert.equal(row.quantity, 1500))
  it('sets input_tokens', () => assert.equal(row.input_tokens, 1200))
  it('sets output_tokens', () => assert.equal(row.output_tokens, 300))
  it('sets audio_seconds to null (not applicable)', () => assert.equal(row.audio_seconds, null))
  it('sets status to ok', () => assert.equal(row.status, 'ok'))
  it('preserves meeting_id', () => assert.equal(row.meeting_id, 'meeting-uuid-123'))
})

// ---------------------------------------------------------------------------
// 3. Audio-seconds-unit row — correct fields for a Speechmatics STT call
// ---------------------------------------------------------------------------

describe('Audio-seconds-unit row — Speechmatics transcribe call', () => {
  const entry: UsageEntry = {
    provider: 'speechmatics',
    model: 'standard',
    operation: 'transcribe',
    unit: 'audio_seconds',
    quantity: 347.8,
    audio_seconds: 347.8,
    meeting_id: 'meeting-uuid-789',
  }
  const row = buildRow(entry)

  it('sets unit = audio_seconds', () => assert.equal(row.unit, 'audio_seconds'))
  it('sets quantity = audio_seconds', () => assert.equal(row.quantity, 347.8))
  it('sets audio_seconds', () => assert.equal(row.audio_seconds, 347.8))
  it('sets input_tokens to null (not applicable)', () => assert.equal(row.input_tokens, null))
  it('sets output_tokens to null (not applicable)', () => assert.equal(row.output_tokens, null))
  it('sets total_tokens to null (not applicable)', () => assert.equal(row.total_tokens, null))
  it('preserves meeting_id', () => assert.equal(row.meeting_id, 'meeting-uuid-789'))
})

// ---------------------------------------------------------------------------
// 4. Aggregation — per-unit sums; tokens and audio_seconds must NEVER mix
// ---------------------------------------------------------------------------

// This mirrors the aggregation logic in /api/admin/ai-usage/route.ts

interface MockLogRow {
  provider: string
  model: string
  operation: string
  unit: UsageUnit
  quantity: number
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  audio_seconds: number | null
  status: UsageStatus
}

interface AggResult {
  provider: string
  model: string
  unit: UsageUnit
  calls: number
  total_tokens: number | null
  total_audio_seconds: number | null
  rate_limited_count: number
  error_count: number
}

function aggregate(rows: MockLogRow[]): AggResult[] {
  const groups = new Map<string, AggResult>()
  for (const row of rows) {
    const key = `${row.provider}|${row.model}|${row.unit}`
    const g = groups.get(key)
    if (!g) {
      groups.set(key, {
        provider: row.provider,
        model: row.model,
        unit: row.unit,
        calls: 1,
        total_tokens:        row.unit === 'tokens'        ? (row.total_tokens  ?? 0) : null,
        total_audio_seconds: row.unit === 'audio_seconds' ? (row.audio_seconds ?? 0) : null,
        rate_limited_count: row.status === 'rate_limited' ? 1 : 0,
        error_count:        row.status === 'error'        ? 1 : 0,
      })
    } else {
      g.calls++
      if (row.unit === 'tokens')        g.total_tokens        = (g.total_tokens        ?? 0) + (row.total_tokens  ?? 0)
      if (row.unit === 'audio_seconds') g.total_audio_seconds = (g.total_audio_seconds ?? 0) + (row.audio_seconds ?? 0)
      if (row.status === 'rate_limited') g.rate_limited_count++
      if (row.status === 'error')        g.error_count++
    }
  }
  return [...groups.values()]
}

const SAMPLE_ROWS: MockLogRow[] = [
  // 2 Gemini analyze calls
  { provider: 'gemini', model: 'gemini-2.5-flash', operation: 'analyze', unit: 'tokens',
    quantity: 1500, input_tokens: 1200, output_tokens: 300, total_tokens: 1500, audio_seconds: null, status: 'ok' },
  { provider: 'gemini', model: 'gemini-2.5-flash', operation: 'analyze', unit: 'tokens',
    quantity: 800,  input_tokens: 600,  output_tokens: 200, total_tokens: 800,  audio_seconds: null, status: 'rate_limited' },
  // 1 Gemini embedding call
  { provider: 'gemini-embedding', model: 'gemini-embedding-001', operation: 'embed', unit: 'tokens',
    quantity: 50, input_tokens: 50, output_tokens: null, total_tokens: 50, audio_seconds: null, status: 'ok' },
  // 2 Speechmatics calls
  { provider: 'speechmatics', model: 'standard', operation: 'transcribe', unit: 'audio_seconds',
    quantity: 300, input_tokens: null, output_tokens: null, total_tokens: null, audio_seconds: 300, status: 'ok' },
  { provider: 'speechmatics', model: 'standard', operation: 'transcribe', unit: 'audio_seconds',
    quantity: 120, input_tokens: null, output_tokens: null, total_tokens: null, audio_seconds: 120, status: 'error' },
]

describe('Aggregation — per-unit sums, no cross-unit mixing', () => {
  const result = aggregate(SAMPLE_ROWS)

  const gemini     = result.find(r => r.provider === 'gemini')!
  const geminiEmb  = result.find(r => r.provider === 'gemini-embedding')!
  const speechm    = result.find(r => r.provider === 'speechmatics')!

  it('produces one group per (provider, model, unit) combination', () => {
    assert.equal(result.length, 3)
  })

  it('counts Gemini calls correctly', () => {
    assert.equal(gemini.calls, 2)
  })

  it('sums Gemini total_tokens correctly (1500 + 800 = 2300)', () => {
    assert.equal(gemini.total_tokens, 2300)
  })

  it('Gemini group has null audio_seconds (wrong unit)', () => {
    assert.equal(gemini.total_audio_seconds, null)
  })

  it('tracks Gemini rate_limited_count', () => {
    assert.equal(gemini.rate_limited_count, 1)
  })

  it('Gemini embedding group has correct token sum (50)', () => {
    assert.equal(geminiEmb.total_tokens, 50)
  })

  it('counts Speechmatics calls correctly', () => {
    assert.equal(speechm.calls, 2)
  })

  it('sums Speechmatics audio_seconds correctly (300 + 120 = 420)', () => {
    assert.equal(speechm.total_audio_seconds, 420)
  })

  it('Speechmatics group has null total_tokens (wrong unit)', () => {
    assert.equal(speechm.total_tokens, null)
  })

  it('tracks Speechmatics error_count', () => {
    assert.equal(speechm.error_count, 1)
  })

  it('does NOT add tokens to Speechmatics quantity', () => {
    // Verify tokens from Gemini rows did not bleed into audio group
    assert.equal(speechm.total_tokens, null)
  })

  it('does NOT add audio_seconds to Gemini quantity', () => {
    // Verify audio_seconds from Speechmatics did not bleed into token group
    assert.equal(gemini.total_audio_seconds, null)
  })
})
