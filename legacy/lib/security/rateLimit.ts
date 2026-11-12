// In-memory per-key rate limiter for auth endpoints.
//
// State is process-local: resets on server restart. Acceptable for a single
// long-lived `next start` process (see CLAUDE.md §2). If the app ever runs as
// multiple instances, swap the Map for a shared Redis/Valkey store — the
// RateLimiter interface is unchanged; only the backing store changes.
//
// DESIGN: rolling window of failure timestamps per key. When `failures.length`
// reaches `maxAttempts` on a `check()` call, a hard block of `blockMs` is set.
// Successful auth resets the key entirely.
//
// NOTE: blockMs should be >= windowMs. If blockMs < windowMs, aged-out failures
// may still exist when the block expires, causing immediate re-blocking — which
// is probably desirable but surprising. Our defaults use equal values.

export interface RateLimitResult {
  allowed: boolean
  /** 0 when allowed. Seconds until the caller may retry. */
  retryAfterSeconds: number
}

export interface RateLimiterOptions {
  /** Number of failures before the key is blocked. */
  maxAttempts: number
  /** Rolling window in milliseconds for counting failures. */
  windowMs: number
  /** How long to block the key after it trips, in milliseconds. */
  blockMs: number
  /** Injectable clock for deterministic unit tests. */
  now?: () => number
}

interface KeyState {
  failures: number[]   // epoch ms timestamps of failures within the current window
  blockedUntil: number // epoch ms; 0 = not blocked
}

export class RateLimiter {
  private readonly store = new Map<string, KeyState>()
  private readonly maxAttempts: number
  private readonly windowMs: number
  private readonly blockMs: number
  private readonly now: () => number

  constructor(opts: RateLimiterOptions) {
    this.maxAttempts = opts.maxAttempts
    this.windowMs    = opts.windowMs
    this.blockMs     = opts.blockMs
    this.now         = opts.now ?? (() => Date.now())
  }

  /**
   * Check whether `key` is currently allowed.
   * Also trips a hard block if in-window failures have reached `maxAttempts`.
   * Does NOT record a failure — call recordFailure() after a confirmed bad attempt.
   */
  check(key: string): RateLimitResult {
    const t = this.now()
    const state = this.store.get(key)

    // Active hard block from a previous trip.
    if (state && state.blockedUntil > t) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((state.blockedUntil - t) / 1_000),
      }
    }

    if (state) {
      // Prune stale failures outside the rolling window.
      state.failures = state.failures.filter(ts => ts > t - this.windowMs)

      if (state.failures.length >= this.maxAttempts) {
        // Trip: set hard block.
        state.blockedUntil = t + this.blockMs
        return { allowed: false, retryAfterSeconds: Math.ceil(this.blockMs / 1_000) }
      }
    }

    return { allowed: true, retryAfterSeconds: 0 }
  }

  /** Record one failure for `key`. Call this on every confirmed failed attempt. */
  recordFailure(key: string): void {
    const t = this.now()
    let state = this.store.get(key)
    if (!state) {
      state = { failures: [], blockedUntil: 0 }
      this.store.set(key, state)
    }
    state.failures = state.failures.filter(ts => ts > t - this.windowMs)
    state.failures.push(t)
  }

  /** Clear all state for `key`. Call this on successful authentication. */
  reset(key: string): void {
    this.store.delete(key)
  }
}

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------

// Login: 5 failures in a 15-minute window → blocked for 15 minutes.
// blockMs === windowMs so failures always age out before the block expires.
export const loginLimiter = new RateLimiter({
  maxAttempts: 5,
  windowMs: 15 * 60 * 1_000,
  blockMs:  15 * 60 * 1_000,
})
