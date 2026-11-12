// Unit tests for KeyPool<C> — the generic multi-key rotation pool.
// All pure: no I/O, no DB, no real API keys.
// Delays are eliminated by setting baseBackoffMs=0, maxBackoffMs=0.
// Fast-fail on cooldowns via maxCooldownWaitMs=0.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KeyPool, AllKeysExhaustedError } from '../lib/keys/pool.js'

type MockClient = { key: string }
const buildClient = (key: string): MockClient => ({ key })

const INSTANT_CFG = {
  defaultCooldownMs: 60_000,
  baseBackoffMs:     0,
  maxBackoffMs:      0,
  maxAttempts:       4,
  maxCooldownWaitMs: 0, // fast-fail immediately when all keys are on cooldown
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('KeyPool — construction', () => {
  it('throws when given an empty key list', () => {
    assert.throws(
      () => new KeyPool<MockClient>([], buildClient, 'test', INSTANT_CFG),
      /No test API keys configured/,
    )
  })

  it('accepts a single key', () => {
    assert.doesNotThrow(
      () => new KeyPool<MockClient>([{ id: null, key: 'k1' }], buildClient, 'test', INSTANT_CFG),
    )
  })
})

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe('KeyPool — success path', () => {
  it('returns the function result on success', async () => {
    const pool = new KeyPool<MockClient>([{ id: null, key: 'mykey' }], buildClient, 'test', INSTANT_CFG)
    const result = await pool.call(async (client) => `got:${client.key}`)
    assert.equal(result, 'got:mykey')
  })

  it('threads the DB key id (null for env-var keys)', async () => {
    const pool = new KeyPool<MockClient>([{ id: 'db-id-1', key: 'k1' }], buildClient, 'test', INSTANT_CFG)
    let receivedId: string | null = undefined as unknown as string | null
    await pool.call(async (_client, keyId) => { receivedId = keyId })
    assert.equal(receivedId, 'db-id-1')
  })

  it('threads null for env-var fallback keys', async () => {
    const pool = new KeyPool<MockClient>([{ id: null, key: 'k1' }], buildClient, 'test', INSTANT_CFG)
    let receivedId: string | null = undefined as unknown as string | null
    await pool.call(async (_client, keyId) => { receivedId = keyId })
    assert.equal(receivedId, null)
  })
})

// ---------------------------------------------------------------------------
// LRU key selection
// ---------------------------------------------------------------------------

describe('KeyPool — LRU selection', () => {
  it('rotates through keys in least-recently-used order', async () => {
    const pool = new KeyPool<MockClient>(
      [{ id: null, key: 'k1' }, { id: null, key: 'k2' }],
      buildClient, 'test', INSTANT_CFG,
    )
    const used: string[] = []
    // With both keys at lastUsedAt=0, LRU picks k1 first (stable reduce tiebreak = first element).
    await pool.call(async (c) => { used.push(c.key) })
    // Now k1 has been used, k2 has lastUsedAt=0 → k2 is least recently used.
    await pool.call(async (c) => { used.push(c.key) })
    // k1 has an older timestamp than k2 → back to k1.
    await pool.call(async (c) => { used.push(c.key) })

    assert.equal(used[0], 'k1')
    assert.equal(used[1], 'k2')
    assert.equal(used[2], 'k1')
  })
})

// ---------------------------------------------------------------------------
// 429 — rate-limit cooldown
// ---------------------------------------------------------------------------

describe('KeyPool — 429 rate-limit rotation', () => {
  it('rotates to the next key when a 429 error is thrown', async () => {
    const pool = new KeyPool<MockClient>(
      [{ id: null, key: 'k1' }, { id: null, key: 'k2' }],
      buildClient, 'test', { ...INSTANT_CFG, maxAttempts: 4 },
    )
    let usedKey = ''
    // k1 always throws 429; k2 succeeds.
    const result = await pool.call(async (client) => {
      if (client.key === 'k1') throw new Error('status 429 RESOURCE_EXHAUSTED')
      usedKey = client.key
      return 'ok'
    })
    assert.equal(result, 'ok')
    assert.equal(usedKey, 'k2')
  })

  it('parses Retry-After from error message', async () => {
    // With 2 keys, first key gets 429 with Retry-After, second key succeeds.
    const pool = new KeyPool<MockClient>(
      [{ id: null, key: 'k1' }, { id: null, key: 'k2' }],
      buildClient, 'test', INSTANT_CFG,
    )
    let attempt = 0
    const result = await pool.call(async (client) => {
      attempt++
      if (attempt === 1) throw new Error('429 quota exceeded retryDelay: 30s')
      return `ok:${client.key}`
    })
    assert.ok(result.startsWith('ok:'))
  })

  it('throws AllKeysExhaustedError when the only key is rate-limited', async () => {
    const pool = new KeyPool<MockClient>(
      [{ id: null, key: 'k1' }],
      buildClient, 'test', { ...INSTANT_CFG, maxAttempts: 2 },
    )
    await assert.rejects(
      pool.call(async () => { throw new Error('429 rate limit') }),
      AllKeysExhaustedError,
    )
  })
})

// ---------------------------------------------------------------------------
// 401 — permanent key disable
// ---------------------------------------------------------------------------

describe('KeyPool — 401 permanent disable', () => {
  it('permanently disables a key after 401 and rotates', async () => {
    const pool = new KeyPool<MockClient>(
      [{ id: null, key: 'k1' }, { id: null, key: 'k2' }],
      buildClient, 'test', INSTANT_CFG,
    )
    let usedKey = ''
    const result = await pool.call(async (client) => {
      if (client.key === 'k1') throw new Error('401 API_KEY_INVALID')
      usedKey = client.key
      return 'ok'
    })
    assert.equal(result, 'ok')
    assert.equal(usedKey, 'k2')

    // Subsequent calls must skip k1 (disabled) and always use k2.
    for (let i = 0; i < 3; i++) {
      let seen = ''
      await pool.call(async (c) => { seen = c.key; return 'ok' })
      assert.equal(seen, 'k2', `call ${i + 1} should use k2 (k1 permanently disabled)`)
    }
  })

  it('throws AllKeysExhaustedError when single key gets 401', async () => {
    const pool = new KeyPool<MockClient>(
      [{ id: null, key: 'k1' }],
      buildClient, 'test', INSTANT_CFG,
    )
    await assert.rejects(
      pool.call(async () => { throw new Error('401 invalid api key') }),
      AllKeysExhaustedError,
    )
  })
})

// ---------------------------------------------------------------------------
// 403 — forbidden (transient long cooldown, NOT permanent)
// ---------------------------------------------------------------------------

describe('KeyPool — 403 transient cooldown', () => {
  it('rotates to the next key when a 403 is thrown', async () => {
    const pool = new KeyPool<MockClient>(
      [{ id: null, key: 'k1' }, { id: null, key: 'k2' }],
      buildClient, 'test', INSTANT_CFG,
    )
    let usedKey = ''
    const result = await pool.call(async (client) => {
      if (client.key === 'k1') throw new Error('403 PERMISSION_DENIED')
      usedKey = client.key
      return 'ok'
    })
    assert.equal(result, 'ok')
    assert.equal(usedKey, 'k2')
  })
})

// ---------------------------------------------------------------------------
// isNonRetryable — surface immediately without rotation
// ---------------------------------------------------------------------------

describe('KeyPool — isNonRetryable callback', () => {
  class AppError extends Error {
    constructor(msg: string) { super(msg); this.name = 'AppError' }
  }

  it('surfaces the error immediately on the first attempt', async () => {
    const pool = new KeyPool<MockClient>(
      [{ id: null, key: 'k1' }, { id: null, key: 'k2' }],
      buildClient, 'test', INSTANT_CFG,
      (err) => err instanceof AppError,
    )
    let attempts = 0
    await assert.rejects(
      pool.call(async () => { attempts++; throw new AppError('bad input') }),
      AppError,
    )
    assert.equal(attempts, 1, 'should not retry a non-retryable error')
  })

  it('does not suppress the original error type', async () => {
    const pool = new KeyPool<MockClient>(
      [{ id: null, key: 'k1' }],
      buildClient, 'test', INSTANT_CFG,
      (err) => err instanceof AppError,
    )
    await assert.rejects(
      pool.call(async () => { throw new AppError('parse failed') }),
      (err: unknown) => err instanceof AppError && err.message === 'parse failed',
    )
  })
})

// ---------------------------------------------------------------------------
// Transient errors — rotate without cooldown
// ---------------------------------------------------------------------------

describe('KeyPool — transient error rotation', () => {
  it('rotates on ECONNRESET (transient network error)', async () => {
    const pool = new KeyPool<MockClient>(
      [{ id: null, key: 'k1' }, { id: null, key: 'k2' }],
      buildClient, 'test', INSTANT_CFG,
    )
    let usedKey = ''
    const result = await pool.call(async (client) => {
      if (client.key === 'k1') throw new Error('fetch failed ECONNRESET')
      usedKey = client.key
      return 'ok'
    })
    assert.equal(result, 'ok')
    assert.equal(usedKey, 'k2')
  })
})

// ---------------------------------------------------------------------------
// maxAttempts exhaustion
// ---------------------------------------------------------------------------

describe('KeyPool — maxAttempts exhaustion', () => {
  it('throws AllKeysExhaustedError after maxAttempts retries', async () => {
    const pool = new KeyPool<MockClient>(
      [{ id: null, key: 'k1' }],
      buildClient, 'test', { ...INSTANT_CFG, maxAttempts: 3 },
    )
    let calls = 0
    const err = await pool.call(async () => { calls++; throw new Error('network error') }).catch(e => e)
    assert.ok(err instanceof AllKeysExhaustedError, 'should throw AllKeysExhaustedError')
    assert.equal(err.keyCount, 1)
  })

  it('AllKeysExhaustedError carries keyCount and attempts', async () => {
    const pool = new KeyPool<MockClient>(
      [{ id: null, key: 'k1' }, { id: null, key: 'k2' }],
      buildClient, 'test', { ...INSTANT_CFG, maxAttempts: 2 },
    )
    const err: unknown = await pool
      .call(async () => { throw new Error('transient') })
      .catch(e => e)
    assert.ok(err instanceof AllKeysExhaustedError)
    assert.equal(err.keyCount, 2)
    assert.equal(err.attempts, 2)
  })
})

// ---------------------------------------------------------------------------
// auto maxAttempts = min(keys.length * 2, 16)
// ---------------------------------------------------------------------------

describe('KeyPool — auto maxAttempts', () => {
  it('auto-resolves 0 to min(keys*2, 16)', async () => {
    // 3 keys → maxAttempts = 6
    const pool = new KeyPool<MockClient>(
      [
        { id: null, key: 'k1' },
        { id: null, key: 'k2' },
        { id: null, key: 'k3' },
      ],
      buildClient, 'test',
      { ...INSTANT_CFG, maxAttempts: 0 },
    )
    let calls = 0
    const err: unknown = await pool
      .call(async () => { calls++; throw new Error('UNAVAILABLE') })
      .catch(e => e)
    assert.ok(err instanceof AllKeysExhaustedError)
    assert.equal(err.attempts, 6)
  })
})
