// Generic multi-key API pool for stateless per-request rotation.
//
// Extracts the core logic from GeminiKeyPool (AIP-01) so it can be reused
// for OpenAI (AIP-05) and any future providers.  SpeechmaticsKeyPool uses a
// different job-aware lease strategy — see lib/keys/speechmatics-pool.ts.
//
// Behavior (identical to the original GeminiKeyPool):
//   - Least-recently-used (LRU) key selection across healthy keys.
//   - 429 / rate-limit  → cooldown from Retry-After header or defaultCooldownMs.
//   - 401 / invalid-key → permanent disable for this process lifetime.
//   - 403 / forbidden   → 15-minute cooldown (transient; NOT permanent).
//   - 5xx / transient   → rotate without cooldown.
//   - bad-request       → surface immediately (PipelineError or HTTP 400).
//   - All healthy keys cooling: wait for soonest expiry; fast-fail if > maxCooldownWaitMs.

import { logger } from '@/lib/logger'

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class AllKeysExhaustedError extends Error {
  readonly keyCount: number
  readonly attempts: number

  constructor(poolName: string, keyCount: number, attempts: number, cause?: unknown) {
    const causeMsg =
      cause instanceof Error ? cause.message : cause != null ? String(cause) : ''
    super(
      `All ${keyCount} ${poolName} key(s) exhausted after ${attempts} attempt(s). ` +
        `Check key validity and quota.` +
        (causeMsg ? ` Last provider error: ${causeMsg}` : ''),
      // Preserve the underlying provider error so describeError() upstream can
      // surface exactly what Gemini/OpenAI returned (429 quota, invalid key, …).
      cause != null ? { cause } : undefined,
    )
    this.name = 'AllKeysExhaustedError'
    this.keyCount = keyCount
    this.attempts = attempts
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface PoolConfig {
  defaultCooldownMs: number
  baseBackoffMs: number
  maxBackoffMs: number
  /** 0 = auto: min(keys.length * 2, 16) */
  maxAttempts: number
  /** Fast-fail if no key will be ready within this window. */
  maxCooldownWaitMs: number
}

// ---------------------------------------------------------------------------
// Per-key state (internal)
// ---------------------------------------------------------------------------

interface KeyState {
  readonly key: string
  readonly keyId: string | null
  readonly index: number
  cooldownUntil: number
  lastUsedAt: number
  consecutiveFailures: number
  disabled: boolean
}

// ---------------------------------------------------------------------------
// Error classification (shared across all providers)
// ---------------------------------------------------------------------------

type ErrorClass = 'rate-limit' | 'invalid-key' | 'forbidden' | 'bad-request' | 'transient' | 'unknown'

function classifyError(err: unknown, isNonRetryable: (e: unknown) => boolean): ErrorClass {
  if (isNonRetryable(err)) return 'bad-request'

  const msg = err instanceof Error ? err.message : String(err)

  if (/\b429\b/.test(msg) || /RESOURCE_EXHAUSTED/i.test(msg) || /quota/i.test(msg)) {
    return 'rate-limit'
  }
  if (/\b401\b/.test(msg) || /API_KEY_INVALID/i.test(msg) || /invalid.api.key/i.test(msg)) {
    return 'invalid-key'
  }
  if (/\b403\b/.test(msg) || /permission.denied/i.test(msg)) {
    return 'forbidden'
  }
  if (/\b400\b/.test(msg)) {
    return 'bad-request'
  }
  if (
    /\b(500|502|503|504)\b/.test(msg) ||
    /UNAVAILABLE/i.test(msg) ||
    /INTERNAL/i.test(msg) ||
    /ECONNRESET/i.test(msg) ||
    /ETIMEDOUT/i.test(msg) ||
    /fetch failed/i.test(msg) ||
    /network/i.test(msg)
  ) {
    return 'transient'
  }
  return 'unknown'
}

function parseRetryAfterMs(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err)
  const m = msg.match(/retry[_\-\s]?(?:after|delay)[:\s=]+(\d+)/i)
  if (m) {
    const s = parseInt(m[1], 10)
    if (!isNaN(s) && s > 0) return s * 1_000
  }
  return null
}

function jitteredDelay(base: number, attempt: number, cap: number): number {
  const exp = Math.min(base * 2 ** attempt, cap)
  return exp * (0.75 + Math.random() * 0.5)
}

// ---------------------------------------------------------------------------
// KeyPool<C>
// ---------------------------------------------------------------------------

export class KeyPool<C> {
  private readonly keys: KeyState[]
  private readonly buildClient: (key: string) => C
  private readonly cfg: PoolConfig
  private readonly poolName: string
  private readonly isNonRetryable: (err: unknown) => boolean

  constructor(
    keys: Array<{ id: string | null; key: string }>,
    buildClient: (key: string) => C,
    poolName: string,
    cfg: PoolConfig,
    /** Return true for errors that should surface immediately without key rotation. */
    isNonRetryable: (err: unknown) => boolean = () => false,
  ) {
    if (keys.length === 0) {
      throw new Error(
        `No ${poolName} API keys configured. ` +
          `Set the appropriate environment variable or add a key via the admin UI.`,
      )
    }
    this.keys = keys.map((k, i) => ({
      key: k.key,
      keyId: k.id,
      index: i + 1,
      cooldownUntil: 0,
      lastUsedAt: 0,
      consecutiveFailures: 0,
      disabled: false,
    }))
    this.buildClient = buildClient
    this.cfg = cfg
    this.poolName = poolName
    this.isNonRetryable = isNonRetryable
    logger.info(`[${poolName} pool] initialised with ${keys.length} key(s)`, { count: keys.length })
  }

  /** Least-recently-used key that is neither cooling down nor disabled. */
  private nextKey(): KeyState | null {
    const now = Date.now()
    const healthy = this.keys.filter(k => !k.disabled && k.cooldownUntil <= now)
    if (healthy.length === 0) return null
    return healthy.reduce((best, k) => (k.lastUsedAt < best.lastUsedAt ? k : best))
  }

  /** Epoch ms when the soonest cooldown expires; null if all disabled. */
  private soonestCooldownMs(): number | null {
    const cooling = this.keys.filter(k => !k.disabled && k.cooldownUntil > Date.now())
    if (cooling.length === 0) return null
    return Math.min(...cooling.map(k => k.cooldownUntil))
  }

  /**
   * Execute `fn` with a healthy client.
   * `fn` receives the client and the DB id of the key used (null for env-var keys).
   *
   * On retryable errors the pool cools-down or disables the used key, picks the
   * next healthy key via LRU, and retries `fn` from scratch.
   */
  async call<T>(fn: (client: C, keyId: string | null) => Promise<T>): Promise<T> {
    const maxAttempts =
      this.cfg.maxAttempts > 0
        ? this.cfg.maxAttempts
        : Math.min(this.keys.length * 2, 16)

    let lastErr: unknown

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const keyState = this.nextKey()

      if (!keyState) {
        const nextMs = this.soonestCooldownMs()
        if (nextMs === null) {
          throw new AllKeysExhaustedError(this.poolName, this.keys.length, attempt, lastErr)
        }
        const waitMs = Math.max(0, nextMs - Date.now()) + 50
        if (waitMs > this.cfg.maxCooldownWaitMs) {
          logger.warn(
            `[${this.poolName} pool] all keys on cooldown for ${Math.round(waitMs / 1_000)}s; exceeds maxCooldownWaitMs — failing fast`,
          )
          throw new AllKeysExhaustedError(this.poolName, this.keys.length, attempt, lastErr)
        }
        logger.warn(
          `[${this.poolName} pool] all keys on cooldown; waiting ${Math.round(waitMs / 1_000)}s for next available key`,
          { count: attempt + 1 },
        )
        await new Promise(r => setTimeout(r, waitMs))
        attempt-- // don't consume attempt slot for a pure cooldown wait
        continue
      }

      keyState.lastUsedAt = Date.now()
      const client = this.buildClient(keyState.key)

      try {
        const result = await fn(client, keyState.keyId)
        keyState.consecutiveFailures = 0
        return result
      } catch (err) {
        lastErr = err
        const errClass = classifyError(err, this.isNonRetryable)

        if (errClass === 'bad-request') {
          throw err // surface immediately — our bug or non-recoverable
        }

        // Full provider message (not truncated) so the exact cause — e.g. the
        // Gemini 429 quota text or an invalid-key reason — is visible in logs.
        const rawMsg = err instanceof Error ? err.message : String(err)

        if (errClass === 'rate-limit') {
          const cooldownMs = parseRetryAfterMs(err) ?? this.cfg.defaultCooldownMs
          keyState.cooldownUntil = Date.now() + cooldownMs
          keyState.consecutiveFailures++
          logger.warn(
            `[${this.poolName} pool] key #${keyState.index} rate-limited; cooldown ${Math.round(cooldownMs / 1_000)}s — rotating`,
            { count: attempt + 1, detail: rawMsg },
          )
        } else if (errClass === 'invalid-key') {
          keyState.disabled = true
          logger.warn(
            `[${this.poolName} pool] key #${keyState.index} rejected with 401 — permanently disabled; rotating`,
            { detail: rawMsg },
          )
        } else if (errClass === 'forbidden') {
          const cooldownMs = 15 * 60 * 1_000
          keyState.cooldownUntil = Date.now() + cooldownMs
          keyState.consecutiveFailures++
          logger.warn(
            `[${this.poolName} pool] key #${keyState.index} got 403/PERMISSION_DENIED; applying 15-min cooldown`,
            { count: attempt + 1, detail: rawMsg },
          )
        } else {
          // transient or unknown — try next key without a cooldown
          keyState.consecutiveFailures++
          logger.warn(
            `[${this.poolName} pool] key #${keyState.index} transient error`,
            { count: attempt + 1, detail: rawMsg },
          )
        }

        if (attempt < maxAttempts - 1) {
          const delay = jitteredDelay(this.cfg.baseBackoffMs, attempt, this.cfg.maxBackoffMs)
          if (delay > 0) await new Promise(r => setTimeout(r, delay))
        }
      }
    }

    throw new AllKeysExhaustedError(this.poolName, this.keys.length, maxAttempts, lastErr)
  }
}
