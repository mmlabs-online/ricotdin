// Unit tests for ADM-05 through ADM-10 pure functions.
//
// Written BEFORE implementation (TDD red phase).
// Imports from lib files that don't exist yet → compile errors until step 2.
//
// Coverage per feature:
//   ADM-07  Audit log      — parseAuditQueryParams (page/perPage clamp, filter parsing)
//   ADM-08  Health         — buildHealthReport (status aggregation), formatUptimeSecs
//   ADM-05  Usage/quota    — computeMeetingStats (by status, rates, windows),
//                            computeStorageStats, formatBytes
//   ADM-06  Storage mgmt   — findOrphans, filterByAge, batchPaths
//   ADM-09  Extended users — validateBulkActionBody, excludeSelf
//   ADM-10  Config flags   — isValidConfigValue, configValueType, parseConfigInput
//
// Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseAuditQueryParams }                         from '../lib/admin/audit-query.js'
import { buildHealthReport, formatUptimeSecs }           from '../lib/admin/health.js'
import { computeMeetingStats, computeStorageStats, formatBytes } from '../lib/admin/usage.js'
import { findOrphans, filterByAge, batchPaths }          from '../lib/admin/storage.js'
import { isValidConfigValue, configValueType, parseConfigInput } from '../lib/admin/config.js'
import { validateBulkActionBody, excludeSelf }           from '../lib/admin/guards.js'

// ============================================================================
// ADM-07 — parseAuditQueryParams
// ============================================================================

describe('ADM-07 parseAuditQueryParams — pagination defaults', () => {
  it('returns page=1 and perPage=20 when params are empty', () => {
    const p = parseAuditQueryParams(new URLSearchParams())
    assert.equal(p.page, 1)
    assert.equal(p.perPage, 20)
  })

  it('parses valid page and perPage', () => {
    const p = parseAuditQueryParams(new URLSearchParams('page=3&perPage=50'))
    assert.equal(p.page, 3)
    assert.equal(p.perPage, 50)
  })

  it('clamps perPage above max to 100', () => {
    const p = parseAuditQueryParams(new URLSearchParams('perPage=999'))
    assert.equal(p.perPage, 100)
  })

  it('clamps perPage below min to 1', () => {
    const p = parseAuditQueryParams(new URLSearchParams('perPage=0'))
    assert.equal(p.perPage, 1)
  })

  it('clamps page below 1 to 1', () => {
    const p = parseAuditQueryParams(new URLSearchParams('page=-5'))
    assert.equal(p.page, 1)
  })

  it('treats non-numeric page/perPage as defaults', () => {
    const p = parseAuditQueryParams(new URLSearchParams('page=abc&perPage=xyz'))
    assert.equal(p.page, 1)
    assert.equal(p.perPage, 20)
  })
})

describe('ADM-07 parseAuditQueryParams — filter params', () => {
  it('returns null for absent actor and action', () => {
    const p = parseAuditQueryParams(new URLSearchParams())
    assert.equal(p.actor, null)
    assert.equal(p.action, null)
  })

  it('passes through actor UUID as-is', () => {
    const p = parseAuditQueryParams(new URLSearchParams('actor=some-uuid'))
    assert.equal(p.actor, 'some-uuid')
  })

  it('passes through action prefix as-is', () => {
    const p = parseAuditQueryParams(new URLSearchParams('action=user.'))
    assert.equal(p.action, 'user.')
  })

  it('accepts valid ISO date string for from', () => {
    const p = parseAuditQueryParams(new URLSearchParams('from=2024-01-01'))
    assert.equal(p.from, '2024-01-01')
  })

  it('rejects invalid date string for from → null', () => {
    const p = parseAuditQueryParams(new URLSearchParams('from=not-a-date'))
    assert.equal(p.from, null)
  })

  it('accepts valid ISO date string for to', () => {
    const p = parseAuditQueryParams(new URLSearchParams('to=2024-12-31'))
    assert.equal(p.to, '2024-12-31')
  })

  it('rejects invalid date string for to → null', () => {
    const p = parseAuditQueryParams(new URLSearchParams('to=garbage'))
    assert.equal(p.to, null)
  })

  it('allows to before from (range inversion is server-side no-op)', () => {
    const p = parseAuditQueryParams(new URLSearchParams('from=2024-12-01&to=2024-01-01'))
    assert.equal(p.from, '2024-12-01')
    assert.equal(p.to, '2024-01-01')
  })
})

// ============================================================================
// ADM-08 — buildHealthReport + formatUptimeSecs
// ============================================================================

describe('ADM-08 buildHealthReport — status aggregation', () => {
  it('returns ok when all checks pass', () => {
    const r = buildHealthReport({ supabase: { status: 'ok' }, gemini: { status: 'ok' } })
    assert.equal(r.status, 'ok')
  })

  it('returns degraded when any check errors', () => {
    const r = buildHealthReport({
      supabase: { status: 'ok' },
      gemini: { status: 'error', message: 'timeout' },
    })
    assert.equal(r.status, 'degraded')
  })

  it('returns degraded when ALL checks error', () => {
    const r = buildHealthReport({
      supabase: { status: 'error', message: 'conn refused' },
      gemini:   { status: 'error', message: 'invalid key' },
    })
    assert.equal(r.status, 'degraded')
  })

  it('returns ok for an empty checks object', () => {
    const r = buildHealthReport({})
    assert.equal(r.status, 'ok')
  })

  it('includes ts field as a non-empty string', () => {
    const r = buildHealthReport({ supabase: { status: 'ok' } })
    assert.ok(typeof r.ts === 'string' && r.ts.length > 0)
  })

  it('accepts an injected ts value', () => {
    const r = buildHealthReport({ supabase: { status: 'ok' } }, '2024-01-01T00:00:00Z')
    assert.equal(r.ts, '2024-01-01T00:00:00Z')
  })

  it('includes all check results in the output', () => {
    const checks = { supabase: { status: 'ok' as const }, gemini: { status: 'error' as const, message: 'x' } }
    const r = buildHealthReport(checks)
    assert.deepEqual(r.checks, checks)
  })
})

describe('ADM-08 formatUptimeSecs', () => {
  it('formats 0 seconds', () => {
    assert.equal(formatUptimeSecs(0), '0s')
  })

  it('formats 45 seconds', () => {
    assert.equal(formatUptimeSecs(45), '45s')
  })

  it('formats exactly 60 seconds as 1m', () => {
    assert.equal(formatUptimeSecs(60), '1m')
  })

  it('formats 90 seconds as 1m 30s', () => {
    assert.equal(formatUptimeSecs(90), '1m 30s')
  })

  it('formats exactly 1 hour', () => {
    assert.equal(formatUptimeSecs(3600), '1h')
  })

  it('formats 1 hour 30 minutes', () => {
    assert.equal(formatUptimeSecs(5400), '1h 30m')
  })

  it('formats 2 hours 5 minutes', () => {
    assert.equal(formatUptimeSecs(7500), '2h 5m')
  })

  it('truncates sub-second fractions', () => {
    assert.equal(formatUptimeSecs(59.9), '59s')
  })
})

// ============================================================================
// ADM-05 — computeMeetingStats, computeStorageStats, formatBytes
// ============================================================================

// Fixed reference time for deterministic date-window tests
const NOW = new Date('2024-06-01T12:00:00Z')

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString()
}

describe('ADM-05 computeMeetingStats — status counts', () => {
  const rows = [
    { status: 'done',       created_at: daysAgo(40) },
    { status: 'done',       created_at: daysAgo(20) },
    { status: 'failed',     created_at: daysAgo(5)  },
    { status: 'pending',    created_at: daysAgo(1)  },
    { status: 'processing', created_at: daysAgo(0)  },
  ]

  it('counts total correctly', () => {
    assert.equal(computeMeetingStats(rows, NOW).total, 5)
  })

  it('counts by status correctly', () => {
    const s = computeMeetingStats(rows, NOW).byStatus
    assert.equal(s['done'],       2)
    assert.equal(s['failed'],     1)
    assert.equal(s['pending'],    1)
    assert.equal(s['processing'], 1)
  })

  it('computes failure rate as failed/total', () => {
    const rate = computeMeetingStats(rows, NOW).failureRate
    assert.equal(rate, 1 / 5)
  })

  it('returns failureRate = 0 for empty list', () => {
    assert.equal(computeMeetingStats([], NOW).failureRate, 0)
  })

  it('counts meetings in last 7 days', () => {
    assert.equal(computeMeetingStats(rows, NOW).last7Days, 3) // failed(5d), pending(1d), processing(0d)
  })

  it('counts meetings in last 30 days', () => {
    assert.equal(computeMeetingStats(rows, NOW).last30Days, 4) // done(20d) + failed + pending + processing
  })

  it('returns zeros for empty input', () => {
    const s = computeMeetingStats([], NOW)
    assert.equal(s.total, 0)
    assert.equal(s.last7Days, 0)
    assert.equal(s.last30Days, 0)
  })
})

describe('ADM-05 computeStorageStats', () => {
  it('sums metadata.size across files', () => {
    const files = [
      { metadata: { size: 100 } },
      { metadata: { size: 200 } },
      { metadata: { size: 300 } },
    ]
    const s = computeStorageStats(files)
    assert.equal(s.totalBytes, 600)
    assert.equal(s.fileCount, 3)
  })

  it('skips entries with null metadata (folders)', () => {
    const files = [{ metadata: null }, { metadata: { size: 50 } }]
    const s = computeStorageStats(files)
    assert.equal(s.totalBytes, 50)
    assert.equal(s.fileCount, 1)
  })

  it('skips entries with undefined size', () => {
    const files = [{ metadata: {} }, { metadata: { size: 80 } }]
    const s = computeStorageStats(files)
    assert.equal(s.totalBytes, 80)
    assert.equal(s.fileCount, 1)
  })

  it('returns zeros for empty list', () => {
    const s = computeStorageStats([])
    assert.equal(s.totalBytes, 0)
    assert.equal(s.fileCount, 0)
  })
})

describe('ADM-05 formatBytes', () => {
  it('formats 0 bytes', () => {
    assert.equal(formatBytes(0), '0 B')
  })

  it('formats bytes under 1 KB', () => {
    assert.equal(formatBytes(512), '512 B')
  })

  it('formats kilobytes', () => {
    assert.equal(formatBytes(1024), '1.0 KB')
  })

  it('formats megabytes', () => {
    assert.equal(formatBytes(1024 * 1024), '1.0 MB')
  })

  it('formats gigabytes', () => {
    assert.equal(formatBytes(1024 * 1024 * 1024), '1.00 GB')
  })

  it('formats fractional MB', () => {
    assert.equal(formatBytes(1.5 * 1024 * 1024), '1.5 MB')
  })
})

// ============================================================================
// ADM-06 — findOrphans, filterByAge, batchPaths
// ============================================================================

describe('ADM-06 findOrphans', () => {
  it('returns paths in storage that are not in the DB set', () => {
    const storage = new Set(['a/b', 'a/c', 'a/d'])
    const db      = new Set(['a/b'])
    assert.deepEqual(findOrphans(storage, db).sort(), ['a/c', 'a/d'])
  })

  it('returns empty array when no orphans exist', () => {
    const storage = new Set(['a/b'])
    const db      = new Set(['a/b'])
    assert.deepEqual(findOrphans(storage, db), [])
  })

  it('returns all paths when DB set is empty', () => {
    const storage = new Set(['x', 'y'])
    assert.equal(findOrphans(storage, new Set()).length, 2)
  })

  it('returns empty array when storage is empty', () => {
    const db = new Set(['a/b'])
    assert.deepEqual(findOrphans(new Set(), db), [])
  })

  it('does not return paths that are in DB but not storage', () => {
    const storage = new Set(['a/b'])
    const db      = new Set(['a/b', 'a/c'])
    assert.deepEqual(findOrphans(storage, db), [])
  })
})

describe('ADM-06 filterByAge', () => {
  const cutoff = new Date('2024-05-01T00:00:00Z')
  const files = [
    { path: 'old1', size: 100, createdAt: '2024-04-01T00:00:00Z' },  // older than cutoff
    { path: 'old2', size: 200, createdAt: '2024-04-30T23:59:59Z' },  // older than cutoff
    { path: 'new1', size: 300, createdAt: '2024-05-01T00:00:01Z' },  // newer
    { path: 'new2', size: 400, createdAt: '2024-06-01T00:00:00Z' },  // newer
  ]

  it('returns only files older than the cutoff', () => {
    const old = filterByAge(files, cutoff)
    assert.equal(old.length, 2)
    assert.deepEqual(old.map((f) => f.path).sort(), ['old1', 'old2'])
  })

  it('returns empty array when no files are old enough', () => {
    const future = new Date('2000-01-01')
    assert.equal(filterByAge(files, future).length, 0)
  })

  it('returns all files when cutoff is far in the future', () => {
    const far = new Date('2099-01-01')
    assert.equal(filterByAge(files, far).length, files.length)
  })
})

describe('ADM-06 batchPaths', () => {
  it('splits into equal batches', () => {
    const paths = Array.from({ length: 9 }, (_, i) => `p${i}`)
    const batches = batchPaths(paths, 3)
    assert.equal(batches.length, 3)
    assert.equal(batches[0].length, 3)
  })

  it('last batch contains remainder', () => {
    const paths = Array.from({ length: 10 }, (_, i) => `p${i}`)
    const batches = batchPaths(paths, 3)
    assert.equal(batches.length, 4)           // 3+3+3+1
    assert.equal(batches[3].length, 1)
  })

  it('returns empty array for empty input', () => {
    assert.deepEqual(batchPaths([], 100), [])
  })

  it('defaults batch size to 100', () => {
    const paths = Array.from({ length: 250 }, (_, i) => `p${i}`)
    const batches = batchPaths(paths)
    assert.equal(batches.length, 3)           // 100+100+50
  })

  it('single batch when items <= batchSize', () => {
    const paths = ['a', 'b', 'c']
    const batches = batchPaths(paths, 10)
    assert.equal(batches.length, 1)
    assert.deepEqual(batches[0], paths)
  })
})

// ============================================================================
// ADM-09 — validateBulkActionBody + excludeSelf
// ============================================================================

describe('ADM-09 validateBulkActionBody — valid inputs', () => {
  it('accepts valid disable body', () => {
    const r = validateBulkActionBody({ ids: ['u1', 'u2'], action: 'disable' })
    assert.equal(r.ok, true)
  })

  it('accepts valid enable body', () => {
    const r = validateBulkActionBody({ ids: ['u1'], action: 'enable' })
    assert.equal(r.ok, true)
  })

  it('accepts set_role body with valid role', () => {
    const r = validateBulkActionBody({ ids: ['u1'], action: 'set_role', role: 'admin' })
    assert.equal(r.ok, true)
  })

  it('returns typed ids and action on success', () => {
    const r = validateBulkActionBody({ ids: ['u1', 'u2'], action: 'disable' })
    if (!r.ok) throw new Error('expected ok')
    assert.deepEqual(r.ids, ['u1', 'u2'])
    assert.equal(r.action, 'disable')
  })
})

describe('ADM-09 validateBulkActionBody — invalid inputs', () => {
  it('rejects null body', () => {
    assert.equal(validateBulkActionBody(null).ok, false)
  })

  it('rejects empty ids array', () => {
    const r = validateBulkActionBody({ ids: [], action: 'disable' })
    assert.equal(r.ok, false)
  })

  it('rejects ids array exceeding 50', () => {
    const r = validateBulkActionBody({ ids: Array(51).fill('u'), action: 'disable' })
    assert.equal(r.ok, false)
  })

  it('rejects unknown action string', () => {
    const r = validateBulkActionBody({ ids: ['u1'], action: 'nuke' })
    assert.equal(r.ok, false)
  })

  it('rejects set_role without role field', () => {
    const r = validateBulkActionBody({ ids: ['u1'], action: 'set_role' })
    assert.equal(r.ok, false)
  })

  it('rejects set_role with invalid role value', () => {
    const r = validateBulkActionBody({ ids: ['u1'], action: 'set_role', role: 'superuser' })
    assert.equal(r.ok, false)
  })

  it('returns status 422 on invalid body', () => {
    const r = validateBulkActionBody({ ids: [], action: 'disable' })
    if (r.ok) throw new Error('expected fail')
    assert.equal(r.status, 422)
  })
})

describe('ADM-09 excludeSelf', () => {
  it('removes caller ID from target list', () => {
    const { safe, selfAttempted } = excludeSelf('u1', ['u1', 'u2', 'u3'])
    assert.deepEqual(safe, ['u2', 'u3'])
    assert.equal(selfAttempted, true)
  })

  it('returns selfAttempted = false when caller not in list', () => {
    const { safe, selfAttempted } = excludeSelf('u1', ['u2', 'u3'])
    assert.deepEqual(safe, ['u2', 'u3'])
    assert.equal(selfAttempted, false)
  })

  it('returns empty safe list if only caller was in list', () => {
    const { safe, selfAttempted } = excludeSelf('u1', ['u1'])
    assert.deepEqual(safe, [])
    assert.equal(selfAttempted, true)
  })

  it('returns all IDs unchanged when caller not present', () => {
    const ids = ['u2', 'u3', 'u4']
    const { safe } = excludeSelf('u1', ids)
    assert.deepEqual(safe, ids)
  })
})

// ============================================================================
// ADM-10 — isValidConfigValue, configValueType, parseConfigInput
// ============================================================================

describe('ADM-10 isValidConfigValue — accepts primitives', () => {
  it('accepts true (boolean)', () => {
    assert.equal(isValidConfigValue(true), true)
  })

  it('accepts false (boolean)', () => {
    assert.equal(isValidConfigValue(false), true)
  })

  it('accepts zero (number)', () => {
    assert.equal(isValidConfigValue(0), true)
  })

  it('accepts positive integer', () => {
    assert.equal(isValidConfigValue(42), true)
  })

  it('accepts empty string', () => {
    assert.equal(isValidConfigValue(''), true)
  })

  it('accepts non-empty string', () => {
    assert.equal(isValidConfigValue('gemini-2.5-flash'), true)
  })

  it('accepts null', () => {
    assert.equal(isValidConfigValue(null), true)
  })
})

describe('ADM-10 isValidConfigValue — rejects complex types', () => {
  it('rejects plain object', () => {
    assert.equal(isValidConfigValue({}), false)
  })

  it('rejects array', () => {
    assert.equal(isValidConfigValue([]), false)
  })

  it('rejects undefined', () => {
    assert.equal(isValidConfigValue(undefined), false)
  })
})

describe('ADM-10 configValueType', () => {
  it('returns boolean for true', () => {
    assert.equal(configValueType(true), 'boolean')
  })

  it('returns boolean for false', () => {
    assert.equal(configValueType(false), 'boolean')
  })

  it('returns number for 0', () => {
    assert.equal(configValueType(0), 'number')
  })

  it('returns number for 42', () => {
    assert.equal(configValueType(42), 'number')
  })

  it('returns string for empty string', () => {
    assert.equal(configValueType(''), 'string')
  })

  it('returns string for non-empty string', () => {
    assert.equal(configValueType('hello'), 'string')
  })

  it('returns null for null', () => {
    assert.equal(configValueType(null), 'null')
  })
})

describe('ADM-10 parseConfigInput', () => {
  it('parses "true" → true (boolean)', () => {
    assert.equal(parseConfigInput('true', 'boolean'), true)
  })

  it('parses "false" → false (boolean)', () => {
    assert.equal(parseConfigInput('false', 'boolean'), false)
  })

  it('parses non-"true" string as false (boolean)', () => {
    assert.equal(parseConfigInput('yes', 'boolean'), false)
  })

  it('parses "42" → 42 (number)', () => {
    assert.equal(parseConfigInput('42', 'number'), 42)
  })

  it('parses "3.14" → 3.14 (number)', () => {
    assert.equal(parseConfigInput('3.14', 'number'), 3.14)
  })

  it('parses string passthrough', () => {
    assert.equal(parseConfigInput('gemini-2.5-flash', 'string'), 'gemini-2.5-flash')
  })

  it('parses null type → null', () => {
    assert.equal(parseConfigInput('anything', 'null'), null)
  })
})
