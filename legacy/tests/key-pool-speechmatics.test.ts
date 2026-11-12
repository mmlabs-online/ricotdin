// Unit tests for SpeechmaticsKeyPool — job-aware least-active key balancing.
// All pure: no I/O, no live Speechmatics calls.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SpeechmaticsKeyPool } from '../lib/keys/speechmatics-pool.js'

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('SpeechmaticsKeyPool — construction', () => {
  it('throws when given no keys', () => {
    assert.throws(() => new SpeechmaticsKeyPool([]), /No Speechmatics API keys configured/)
  })

  it('accepts a single key', () => {
    const pool = new SpeechmaticsKeyPool([{ id: null, key: 'sk-test' }])
    assert.equal(pool.size, 1)
  })
})

// ---------------------------------------------------------------------------
// acquire / release — single key
// ---------------------------------------------------------------------------

describe('SpeechmaticsKeyPool — single key behaviour', () => {
  it('returns the only key', () => {
    const pool = new SpeechmaticsKeyPool([{ id: 'db-1', key: 'api-key-1' }])
    const acq = pool.acquire()
    assert.equal(acq.apiKey, 'api-key-1')
    assert.equal(acq.keyId, 'db-1')
    assert.equal(acq.keyIndex, 0)
  })

  it('always returns index 0 for single key', () => {
    const pool = new SpeechmaticsKeyPool([{ id: null, key: 'k1' }])
    for (let i = 0; i < 5; i++) {
      const acq = pool.acquire()
      assert.equal(acq.keyIndex, 0)
    }
  })

  it('acquire increments inFlight count', () => {
    const pool = new SpeechmaticsKeyPool([{ id: null, key: 'k1' }])
    assert.equal(pool.inFlightCount(0), 0)
    pool.acquire()
    assert.equal(pool.inFlightCount(0), 1)
    pool.acquire()
    assert.equal(pool.inFlightCount(0), 2)
  })

  it('release decrements inFlight count', () => {
    const pool = new SpeechmaticsKeyPool([{ id: null, key: 'k1' }])
    pool.acquire()
    pool.acquire()
    pool.release(0)
    assert.equal(pool.inFlightCount(0), 1)
  })

  it('release does not go below 0', () => {
    const pool = new SpeechmaticsKeyPool([{ id: null, key: 'k1' }])
    pool.release(0) // no in-flight — should not throw or go negative
    assert.equal(pool.inFlightCount(0), 0)
  })

  it('release with out-of-range index is a safe no-op', () => {
    const pool = new SpeechmaticsKeyPool([{ id: null, key: 'k1' }])
    assert.doesNotThrow(() => pool.release(99))
    assert.doesNotThrow(() => pool.release(-1))
  })
})

// ---------------------------------------------------------------------------
// Least-active selection with multiple keys
// ---------------------------------------------------------------------------

describe('SpeechmaticsKeyPool — least-active selection', () => {
  it('picks first key when all are tied at 0 in-flight', () => {
    const pool = new SpeechmaticsKeyPool([
      { id: null, key: 'ka' },
      { id: null, key: 'kb' },
    ])
    const acq = pool.acquire()
    assert.equal(acq.apiKey, 'ka')
    assert.equal(acq.keyIndex, 0)
  })

  it('picks the key with fewer in-flight jobs', () => {
    const pool = new SpeechmaticsKeyPool([
      { id: null, key: 'ka' },
      { id: null, key: 'kb' },
    ])
    pool.acquire() // ka: 1 in-flight, kb: 0
    const second = pool.acquire() // kb has fewer → picks kb
    assert.equal(second.apiKey, 'kb')
    assert.equal(second.keyIndex, 1)
  })

  it('balances across keys as jobs complete', () => {
    const pool = new SpeechmaticsKeyPool([
      { id: null, key: 'ka' },
      { id: null, key: 'kb' },
    ])
    const a1 = pool.acquire() // ka=1, kb=0
    const a2 = pool.acquire() // ka=1, kb=1 after a2 — actually: ka=1, kb=0 → picks kb
    // After a2: ka=1, kb=1

    pool.release(a1.keyIndex) // ka=0, kb=1
    const a3 = pool.acquire() // ka=0 < kb=1 → picks ka
    assert.equal(a3.apiKey, 'ka')

    pool.release(a2.keyIndex) // kb=0
    pool.release(a3.keyIndex) // ka=0
    assert.equal(pool.inFlightCount(0), 0)
    assert.equal(pool.inFlightCount(1), 0)
  })

  it('distributes load round-robin when keys are repeatedly tied', () => {
    const pool = new SpeechmaticsKeyPool([
      { id: null, key: 'k1' },
      { id: null, key: 'k2' },
      { id: null, key: 'k3' },
    ])
    // Sequential acquire+release: each job goes to first-tied key (k1 always).
    for (let i = 0; i < 4; i++) {
      const acq = pool.acquire()
      assert.equal(acq.keyIndex, 0, `iteration ${i}: tied keys → picks first (index 0)`)
      pool.release(acq.keyIndex)
    }
  })

  it('accounts for inFlight correctly with multiple concurrent jobs', () => {
    const pool = new SpeechmaticsKeyPool([
      { id: null, key: 'k1' },
      { id: null, key: 'k2' },
    ])
    // Simulate 3 concurrent jobs
    const j1 = pool.acquire() // k1 (tied → first)
    const j2 = pool.acquire() // k2 (k1=1, k2=0 → k2)
    const j3 = pool.acquire() // tied at 1 → k1

    assert.equal(pool.inFlightCount(0), 2) // k1: j1 + j3
    assert.equal(pool.inFlightCount(1), 1) // k2: j2

    pool.release(j1.keyIndex) // k1=1, k2=1
    const j4 = pool.acquire() // tied → k1
    assert.equal(j4.keyIndex, 0)

    pool.release(j2.keyIndex)
    pool.release(j3.keyIndex)
    pool.release(j4.keyIndex)
    assert.equal(pool.inFlightCount(0), 0)
    assert.equal(pool.inFlightCount(1), 0)
  })
})
