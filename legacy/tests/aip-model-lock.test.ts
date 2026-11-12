// Unit tests for AIP-03 per-meeting model lock helper.
// All pure — no DB, no provider calls; getDefaultGenerationModel() reads from
// the in-memory registry which is initialized at module load (no I/O).
// Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveModelLock } from '../lib/ai/lock.js'

describe('resolveModelLock — stored lock present', () => {
  it('returns the stored provider+model when both are set', () => {
    const result = resolveModelLock('gemini', 'gemini-2.5-flash')
    assert.equal(result.provider, 'gemini')
    assert.equal(result.model, 'gemini-2.5-flash')
  })

  it('passes through an unknown provider verbatim (adapter lookup deferred to call site)', () => {
    const result = resolveModelLock('openai', 'gpt-4o')
    assert.equal(result.provider, 'openai')
    assert.equal(result.model, 'gpt-4o')
  })

  it('passes through a future model name verbatim', () => {
    const result = resolveModelLock('gemini', 'gemini-3.0-ultra')
    assert.equal(result.provider, 'gemini')
    assert.equal(result.model, 'gemini-3.0-ultra')
  })
})

describe('resolveModelLock — no stored lock (falls back to system default)', () => {
  it('returns the system default when both are null', () => {
    const result = resolveModelLock(null, null)
    assert.equal(result.provider, 'gemini')
    assert.equal(result.model, 'gemini-2.5-flash')
  })

  it('returns the system default when both are undefined', () => {
    const result = resolveModelLock(undefined, undefined)
    assert.equal(result.provider, 'gemini')
    assert.equal(result.model, 'gemini-2.5-flash')
  })

  it('returns the system default when provider is null (one-side null — DB CHECK prevents this at rest)', () => {
    const result = resolveModelLock(null, 'gemini-2.5-flash')
    assert.equal(result.provider, 'gemini')
    assert.equal(result.model, 'gemini-2.5-flash')
  })

  it('returns the system default when model is null (one-side null — DB CHECK prevents this at rest)', () => {
    const result = resolveModelLock('gemini', null)
    assert.equal(result.provider, 'gemini')
    assert.equal(result.model, 'gemini-2.5-flash')
  })

  it('returns the system default for empty strings (treated as falsy, same as null)', () => {
    const result = resolveModelLock('', '')
    assert.equal(result.provider, 'gemini')
    assert.equal(result.model, 'gemini-2.5-flash')
  })
})

describe('resolveModelLock — return shape', () => {
  it('result has exactly provider and model keys', () => {
    const result = resolveModelLock('gemini', 'gemini-2.5-flash')
    assert.ok('provider' in result, 'has provider')
    assert.ok('model' in result, 'has model')
    assert.equal(typeof result.provider, 'string')
    assert.equal(typeof result.model, 'string')
  })
})
