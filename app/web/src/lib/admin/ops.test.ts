import { describe, expect, it } from 'vitest'
import {
  PROVIDER_ORDER,
  canRequeue,
  dailyBars,
  dateInput,
  defaultRange,
  durationParts,
  eventKey,
  metadataText,
  pipelineFilter,
  rangeProblem,
  usageSummary,
  uuidOrNull,
} from './ops'

describe('pipelineFilter', () => {
  it('reads the status filter the API accepts, else all', () => {
    expect(pipelineFilter('stuck')).toBe('stuck')
    expect(pipelineFilter('failed')).toBe('failed')
    expect(pipelineFilter('')).toBe('all')
    expect(pipelineFilter(null)).toBe('all')
    expect(pipelineFilter('queued')).toBe('all')
  })
})

describe('canRequeue', () => {
  const job = (over: Record<string, unknown> = {}) => ({ status: 'failed', is_stuck: false, job: { status: 'failed', step: 'start', attempts: 3, last_error: null }, ...over })
  it('failed or stuck meetings without a queued/running job (the API answers 422/409 otherwise)', () => {
    expect(canRequeue(job())).toBe(true)
    expect(canRequeue(job({ status: 'processing', is_stuck: true, job: null }))).toBe(true)
    expect(canRequeue(job({ status: 'done' }))).toBe(false)
    expect(canRequeue(job({ status: 'processing' }))).toBe(false)
    expect(canRequeue(job({ job: { status: 'queued', step: 'start', attempts: 0, last_error: null } }))).toBe(false)
    expect(canRequeue(job({ job: { status: 'running', step: 'analyse', attempts: 1, last_error: null } }))).toBe(false)
  })
})

describe('durationParts', () => {
  it('splits seconds, null when unknown', () => {
    expect(durationParts(3725)).toEqual({ h: 1, m: 2, s: 5 })
    expect(durationParts(59.6)).toEqual({ h: 0, m: 1, s: 0 })
    expect(durationParts(null)).toBeNull()
    expect(durationParts(-1)).toBeNull()
  })
})

describe('date range', () => {
  const now = new Date('2026-11-05T03:00:00Z')
  it('defaults to the last 30 days (UTC dates)', () => {
    expect(defaultRange(now)).toEqual({ from: '2026-10-06', to: '2026-11-05' })
    expect(dateInput('2026-02-30')).toBeNull()
    expect(dateInput('2026-02-28')).toBe('2026-02-28')
    expect(dateInput('1969-12-31')).toBeNull()
    expect(dateInput('x')).toBeNull()
  })
  it('the API refuses more than 400 days or an inverted range', () => {
    expect(rangeProblem('2026-01-01', '2026-11-05')).toBeNull()
    expect(rangeProblem('2025-01-01', '2026-11-05')).toBe('admin.usage.errors.tooLong')
    expect(rangeProblem('2026-11-06', '2026-11-05')).toBe('admin.usage.errors.order')
    expect(rangeProblem('', '2026-11-05')).toBe('admin.usage.errors.date')
  })
})

describe('usageSummary', () => {
  const row = (over: Record<string, unknown>) => ({
    provider: 'gemini', model: 'm', operation: null, unit: 'tokens', key_id: null, key_label: null, key_last4: null, calls: 1,
    total_tokens: 0, total_input_tokens: 0, total_output_tokens: 0, total_audio_seconds: null, rate_limited_count: 0, error_count: 0, ...over,
  })
  it('keeps tokens and audio seconds apart (never summed together)', () => {
    const s = usageSummary([
      row({ calls: 10, total_tokens: 1500, total_input_tokens: 1000, total_output_tokens: 500, rate_limited_count: 2 }),
      row({ provider: 'openai', calls: 5, total_tokens: 100, total_input_tokens: 60, total_output_tokens: 40, error_count: 1 }),
      row({ provider: 'speechmatics', unit: 'audio_seconds', calls: 3, total_tokens: null, total_input_tokens: null, total_output_tokens: null, total_audio_seconds: 5400 }),
    ])
    expect(s).toEqual({
      tokenCalls: 15, inputTokens: 1060, outputTokens: 540, totalTokens: 1600,
      audioCalls: 3, audioSeconds: 5400, rateLimited: 2, errors: 1, calls: 18,
    })
    expect(s.tokenCalls + s.audioCalls).toBe(s.calls)
  })
  it('ignores malformed rows', () => {
    expect(usageSummary([row({ unit: 'bytes', calls: 99 }), null, 'x'] as never).calls).toBe(0)
  })
})

describe('dailyBars', () => {
  it('one bar per day of one unit, stacked by provider in a fixed order', () => {
    const d = dailyBars(
      [
        { date: '2026-11-02', provider: 'openai', unit: 'tokens', quantity: 30 },
        { date: '2026-11-02', provider: 'gemini', unit: 'tokens', quantity: 70 },
        { date: '2026-11-03', provider: 'gemini', unit: 'tokens', quantity: 50 },
        { date: '2026-11-03', provider: 'speechmatics', unit: 'audio_seconds', quantity: 600 },
      ],
      'tokens',
    )
    expect(d.max).toBe(100)
    expect(d.providers).toEqual(['gemini', 'openai'])
    expect(d.days).toEqual([
      { date: '2026-11-02', total: 100, parts: [{ provider: 'gemini', quantity: 70 }, { provider: 'openai', quantity: 30 }] },
      { date: '2026-11-03', total: 50, parts: [{ provider: 'gemini', quantity: 50 }] },
    ])
  })
  it('a provider keeps its slot whatever else is shown (colour follows the entity)', () => {
    expect(PROVIDER_ORDER.indexOf('openai')).toBe(1)
    const d = dailyBars([{ date: '2026-11-02', provider: 'grok', unit: 'tokens', quantity: 1 }], 'tokens')
    expect(d.providers).toEqual(['grok'])
  })
  it('with a range, every day gets a bar (empty days are 0), so the axis is continuous', () => {
    const d = dailyBars([{ date: '2026-11-03', provider: 'gemini', unit: 'tokens', quantity: 5 }], 'tokens', { from: '2026-11-01', to: '2026-11-04' })
    expect(d.days.map((x) => [x.date, x.total])).toEqual([
      ['2026-11-01', 0],
      ['2026-11-02', 0],
      ['2026-11-03', 5],
      ['2026-11-04', 0],
    ])
    expect(dailyBars([], 'tokens', { from: '2026-11-01', to: '2026-11-02' }).days).toHaveLength(2)
    // rows outside the range are dropped; an over-long range is capped at 400 days
    expect(dailyBars([{ date: '2026-12-01', provider: 'gemini', unit: 'tokens', quantity: 5 }], 'tokens', { from: '2026-11-01', to: '2026-11-01' }).max).toBe(0)
    expect(dailyBars([], 'tokens', { from: '2020-01-01', to: '2026-11-01' }).days).toHaveLength(400)
  })
  it('unknown providers sort after the known ones; bad rows are skipped', () => {
    const d = dailyBars(
      [
        { date: '2026-11-02', provider: 'zeta', unit: 'tokens', quantity: 1 },
        { date: '2026-11-02', provider: 'gemini', unit: 'tokens', quantity: 1 },
        { date: 'nope', provider: 'gemini', unit: 'tokens', quantity: 1 },
        { date: '2026-11-02', provider: 'gemini', unit: 'tokens', quantity: Number.NaN },
      ],
      'tokens',
    )
    expect(d.providers).toEqual(['gemini', 'zeta'])
    expect(d.days[0]?.total).toBe(2)
  })
})

describe('eventKey', () => {
  it('known activity events get a label, others a generic one', () => {
    expect(eventKey('processing_done')).toBe('admin.events.processing_done')
    expect(eventKey('recording_notice_ack')).toBe('admin.events.recording_notice_ack')
    expect(eventKey('meeting_viewed')).toBe('admin.events.other')
    expect(eventKey('a.b')).toBe('admin.events.other')
  })
})

describe('metadataText', () => {
  it('JSON as text, bounded; nothing for empty', () => {
    expect(metadataText({ a: 1 })).toBe('{"a":1}')
    expect(metadataText(null)).toBeNull()
    expect(metadataText({})).toBeNull()
    expect(metadataText({ x: 'y'.repeat(1000) })?.length).toBe(500)
  })
})

describe('uuidOrNull', () => {
  it('only a uuid reaches the API filter', () => {
    expect(uuidOrNull('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe('0f8fad5b-d9cb-469f-a165-70867728950e')
    expect(uuidOrNull('x')).toBeNull()
    expect(uuidOrNull(null)).toBeNull()
  })
})
