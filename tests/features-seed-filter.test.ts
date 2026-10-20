// Unit tests for the feature seeder's --only filter.
//
// All tests are pure (no I/O, no DB): they exercise lib/features/seedFilter.ts.
//
// Covered scenarios:
//   1. parseOnlyKeys — no flag, `--only A,B`, `--only=A,B`, normalisation, bad input
//   2. selectFeatures — null = all, subset selection, missing keys reported

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseOnlyKeys,
  selectFeatures,
  SeedArgsError,
} from '../lib/features/seedFilter.js'

// ── 1. parseOnlyKeys ──────────────────────────────────────────────────────────

describe('parseOnlyKeys', () => {
  it('returns null when --only is absent (seed everything)', () => {
    assert.equal(parseOnlyKeys([]), null)
    assert.equal(parseOnlyKeys(['--verbose']), null)
  })

  it('parses space-separated form: --only A,B', () => {
    assert.deepEqual(parseOnlyKeys(['--only', 'PRO-09,REC-12']), ['PRO-09', 'REC-12'])
  })

  it('parses equals form: --only=A,B', () => {
    assert.deepEqual(parseOnlyKeys(['--only=PRO-09,REC-12']), ['PRO-09', 'REC-12'])
  })

  it('trims, uppercases and de-duplicates keys', () => {
    assert.deepEqual(parseOnlyKeys(['--only', ' pro-09 , PRO-09,rec-12 ']), ['PRO-09', 'REC-12'])
  })

  it('throws SeedArgsError when --only has no value', () => {
    assert.throws(() => parseOnlyKeys(['--only']), SeedArgsError)
    assert.throws(() => parseOnlyKeys(['--only=']), SeedArgsError)
    assert.throws(() => parseOnlyKeys(['--only', '--verbose']), SeedArgsError)
  })

  it('throws SeedArgsError on a malformed feature code', () => {
    assert.throws(() => parseOnlyKeys(['--only', 'PRO09']), SeedArgsError)
    assert.throws(() => parseOnlyKeys(['--only', 'PRO-09,; drop table']), SeedArgsError)
  })
})

// ── 2. selectFeatures ─────────────────────────────────────────────────────────

describe('selectFeatures', () => {
  const features = [{ key: 'REC-01' }, { key: 'PRO-08' }, { key: 'PRO-09' }]

  it('returns every feature when onlyKeys is null', () => {
    const { selected, missing } = selectFeatures(features, null)
    assert.deepEqual(selected, features)
    assert.deepEqual(missing, [])
  })

  it('returns only the requested keys', () => {
    const { selected, missing } = selectFeatures(features, ['PRO-09'])
    assert.deepEqual(selected, [{ key: 'PRO-09' }])
    assert.deepEqual(missing, [])
  })

  it('reports requested keys that have no parsed feature section', () => {
    const { selected, missing } = selectFeatures(features, ['PRO-09', 'PRO-10'])
    assert.deepEqual(selected, [{ key: 'PRO-09' }])
    assert.deepEqual(missing, ['PRO-10'])
  })
})
