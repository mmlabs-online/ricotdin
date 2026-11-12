// Pure unit tests for the in-memory rate limiter.
// No I/O, no mocks — all assertions against deterministic outputs.
// Clock is injected so time is fully controlled.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { RateLimiter } from '../lib/security/rateLimit'

function makeClock(startMs = 0): { now: () => number; advance: (ms: number) => void } {
  let t = startMs
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('RateLimiter — basic', () => {
  test('fresh key is allowed', () => {
    const rl = new RateLimiter({ maxAttempts: 3, windowMs: 60_000, blockMs: 60_000 })
    const r = rl.check('ip1')
    assert.equal(r.allowed, true)
    assert.equal(r.retryAfterSeconds, 0)
  })

  test('allowed while under the failure limit', () => {
    const clock = makeClock()
    const rl = new RateLimiter({ maxAttempts: 3, windowMs: 60_000, blockMs: 60_000, now: clock.now })
    rl.recordFailure('ip1')
    rl.recordFailure('ip1')
    assert.equal(rl.check('ip1').allowed, true)
  })

  test('blocked exactly at maxAttempts', () => {
    const clock = makeClock()
    const rl = new RateLimiter({ maxAttempts: 3, windowMs: 60_000, blockMs: 60_000, now: clock.now })
    rl.recordFailure('ip1')
    rl.recordFailure('ip1')
    rl.recordFailure('ip1')
    const r = rl.check('ip1')
    assert.equal(r.allowed, false)
    assert.ok(r.retryAfterSeconds > 0)
  })

  test('retryAfterSeconds equals blockMs in seconds on the tripping check', () => {
    const clock = makeClock()
    const rl = new RateLimiter({ maxAttempts: 2, windowMs: 60_000, blockMs: 900_000, now: clock.now })
    rl.recordFailure('ip1')
    rl.recordFailure('ip1')
    const r = rl.check('ip1')
    assert.equal(r.allowed, false)
    assert.equal(r.retryAfterSeconds, 900)
  })

  test('subsequent checks while blocked carry correct retryAfter', () => {
    const clock = makeClock()
    const rl = new RateLimiter({ maxAttempts: 2, windowMs: 60_000, blockMs: 60_000, now: clock.now })
    rl.recordFailure('ip1')
    rl.recordFailure('ip1')
    rl.check('ip1') // trips; blockedUntil = 60000

    clock.advance(10_000) // 10 s later
    const r = rl.check('ip1')
    assert.equal(r.allowed, false)
    assert.equal(r.retryAfterSeconds, 50) // 60 - 10 = 50 s remaining
  })
})

describe('RateLimiter — time expiry', () => {
  test('allowed again after block expires', () => {
    const clock = makeClock()
    const rl = new RateLimiter({ maxAttempts: 2, windowMs: 60_000, blockMs: 60_000, now: clock.now })
    rl.recordFailure('ip1')
    rl.recordFailure('ip1')
    rl.check('ip1') // trips

    clock.advance(60_001) // past block + window
    assert.equal(rl.check('ip1').allowed, true)
  })

  test('failures age out of window without tripping a block', () => {
    const clock = makeClock()
    const rl = new RateLimiter({ maxAttempts: 3, windowMs: 60_000, blockMs: 300_000, now: clock.now })
    rl.recordFailure('ip1')
    rl.recordFailure('ip1')
    assert.equal(rl.check('ip1').allowed, true) // 2 < 3

    clock.advance(60_001) // window expires
    assert.equal(rl.check('ip1').allowed, true) // old failures pruned, no block
  })
})

describe('RateLimiter — reset on success', () => {
  test('reset clears an active block', () => {
    const clock = makeClock()
    const rl = new RateLimiter({ maxAttempts: 2, windowMs: 60_000, blockMs: 300_000, now: clock.now })
    rl.recordFailure('ip1')
    rl.recordFailure('ip1')
    rl.check('ip1') // trips

    rl.reset('ip1')
    assert.equal(rl.check('ip1').allowed, true)
  })

  test('reset clears partial failure count', () => {
    const clock = makeClock()
    const rl = new RateLimiter({ maxAttempts: 5, windowMs: 60_000, blockMs: 60_000, now: clock.now })
    rl.recordFailure('ip1')
    rl.recordFailure('ip1')
    rl.recordFailure('ip1')
    // Not yet blocked
    rl.reset('ip1')
    // Now even 2 more failures won't carry over
    rl.recordFailure('ip1')
    rl.recordFailure('ip1')
    assert.equal(rl.check('ip1').allowed, true)
  })
})

describe('RateLimiter — isolation', () => {
  test('keys are independent', () => {
    const clock = makeClock()
    const rl = new RateLimiter({ maxAttempts: 2, windowMs: 60_000, blockMs: 60_000, now: clock.now })
    rl.recordFailure('ip1')
    rl.recordFailure('ip1')
    rl.check('ip1') // ip1 blocked

    assert.equal(rl.check('ip2').allowed, true)
  })

  test('sentinel __unknown__ key works correctly', () => {
    const clock = makeClock()
    const rl = new RateLimiter({ maxAttempts: 2, windowMs: 60_000, blockMs: 60_000, now: clock.now })
    rl.recordFailure('__unknown__')
    rl.recordFailure('__unknown__')
    assert.equal(rl.check('__unknown__').allowed, false)
  })
})
