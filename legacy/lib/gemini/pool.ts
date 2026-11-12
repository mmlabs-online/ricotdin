// SERVER ONLY — reads Gemini API keys which must never reach the browser.
//
// Multi-key pool with round-robin (LRU) selection, per-key cooldown tracking,
// and automatic rotation on 429 / 5xx / network errors.
//
// Usage — stateless calls (text generation, embeddings):
//   import { geminiPool } from './pool'
//   const result = await geminiPool.call(ai => ai.models.generateContent({...}))
//
// Usage — Files-API sessions (upload → generate → delete):
//   The entire sequence MUST be in one call() so the same key is used throughout.
//   Gemini files are scoped to the key that uploaded them.
//   const result = await geminiPool.call(async ai => {
//     const file = await ai.files.upload({...})
//     try {
//       return await ai.models.generateContent({...})
//     } finally {
//       ai.files.delete({ name: file.name }).catch(() => {})
//     }
//   })
//
// Key sources (checked in order, de-duplicated):
//   1. GEMINI_API_KEYS=key1,key2,key3   (comma-separated)
//   2. GEMINI_API_KEY_1, GEMINI_API_KEY_2, ... GEMINI_API_KEY_20
//   3. GEMINI_API_KEY  (legacy single key — still works)
//
// Tunables (all optional, have sane defaults):
//   GEMINI_DEFAULT_COOLDOWN_MS  default 60000
//   GEMINI_BASE_BACKOFF_MS      default 500
//   GEMINI_MAX_BACKOFF_MS       default 8000
//   GEMINI_MAX_ATTEMPTS         default 0 (= min(keys*2, 16))
//   GEMINI_MAX_COOLDOWN_WAIT_MS default 30000 (fast-fail if cooldown > this)
//
// Error classification nuance:
//   401             → 'invalid-key'  → permanent disable (key is definitively rejected)
//   403/PERMISSION  → 'forbidden'    → 15-min cooldown (may be transient; NOT permanent)
//   429/EXHAUSTED   → 'rate-limit'   → short cooldown from Retry-After header

import { GoogleGenAI } from '@google/genai'
import { PipelineError } from './errors'
import { KeyPool, AllKeysExhaustedError } from '@/lib/keys/pool'
import type { PoolConfig } from '@/lib/keys/pool'
import { getActiveKeysWithMeta } from '@/lib/keys/provider'

// ---------------------------------------------------------------------------
// Exported error type — kept here so worker.ts can still import it from this path.
// MUST extend PipelineError so the worker's isTerminalError check works.
// ---------------------------------------------------------------------------

export class AllGeminiKeysExhaustedError extends PipelineError {
  constructor(keyCount: number, attempts: number, cause?: unknown) {
    const causeMsg =
      cause instanceof Error ? cause.message : cause != null ? String(cause) : ''
    super(
      `All ${keyCount} Gemini key(s) exhausted after ${attempts} attempt(s). ` +
        `Check key validity and quota. The meeting will be marked failed and can be re-run.` +
        (causeMsg ? ` Last Gemini error: ${causeMsg}` : ''),
    )
    this.name = 'AllGeminiKeysExhaustedError'
    // Preserve the raw Gemini error for describeError() upstream.
    if (cause != null) (this as { cause?: unknown }).cause = cause
  }
}

// ---------------------------------------------------------------------------
// Config (Gemini-specific env var names)
// ---------------------------------------------------------------------------

function readConfig(): PoolConfig {
  const n = (key: string, fallback: number) =>
    parseInt(process.env[key] ?? '', 10) || fallback
  return {
    defaultCooldownMs: n('GEMINI_DEFAULT_COOLDOWN_MS', 60_000),
    baseBackoffMs:     n('GEMINI_BASE_BACKOFF_MS', 500),
    maxBackoffMs:      n('GEMINI_MAX_BACKOFF_MS', 8_000),
    maxAttempts:       n('GEMINI_MAX_ATTEMPTS', 0),
    maxCooldownWaitMs: n('GEMINI_MAX_COOLDOWN_WAIT_MS', 30_000),
  }
}

// ---------------------------------------------------------------------------
// GeminiKeyPool — thin wrapper around KeyPool<GoogleGenAI>.
//
// KeyPool<C> provides: LRU selection, 429 cooldown, 401 permanent disable,
// 403 15-min cooldown, 5xx rotate-without-cooldown, PipelineError surface-immediately.
// This class only adds AllGeminiKeysExhaustedError wrapping.
// ---------------------------------------------------------------------------

class GeminiKeyPool {
  private readonly pool: KeyPool<GoogleGenAI>

  constructor(keys: Array<{ id: string | null; key: string }>, cfg: PoolConfig) {
    this.pool = new KeyPool<GoogleGenAI>(
      keys,
      (key) => new GoogleGenAI({ apiKey: key }),
      'gemini',
      cfg,
      // PipelineError = our own validation/parse failure — surface immediately.
      (err) => err instanceof PipelineError,
    )
  }

  /**
   * Execute `fn` with a healthy GoogleGenAI client.
   * `fn` receives the client and the DB id of the key used (null for env-var keys).
   *
   * On retryable errors the pool puts the used key on cooldown (or disables it),
   * picks the next healthy key via LRU, and retries `fn` from scratch.
   *
   * For Files-API sessions the entire upload+generate+delete sequence should be
   * inside a single call() so the same key is used throughout.
   */
  async call<T>(fn: (ai: GoogleGenAI, keyId: string | null) => Promise<T>): Promise<T> {
    try {
      return await this.pool.call(fn)
    } catch (err) {
      if (err instanceof AllKeysExhaustedError) {
        throw new AllGeminiKeysExhaustedError(
          err.keyCount,
          err.attempts,
          (err as { cause?: unknown }).cause,
        )
      }
      throw err
    }
  }
}

// ---------------------------------------------------------------------------
// Pool singleton with TTL-based refresh.
//
// The pool is re-created every POOL_TTL_MS (30 s) so newly added or disabled
// DB keys take effect without a process restart. Per-key cooldown state is
// intentionally lost on refresh — cooldowns naturally expire within the TTL.
//
// resetGeminiPool() forces an immediate refresh (call after key mutations).
// ---------------------------------------------------------------------------

const POOL_TTL_MS = 30_000

let _pool:        GeminiKeyPool | null = null
let _poolLoadedAt = 0

/** Force the pool to reload keys on the next call (used after key mutations). */
export function resetGeminiPool(): void {
  _pool = null
  _poolLoadedAt = 0
}

async function getPoolAsync(): Promise<GeminiKeyPool> {
  const now = Date.now()
  if (!_pool || now - _poolLoadedAt > POOL_TTL_MS) {
    const keys = await getActiveKeysWithMeta('gemini')
    _pool = new GeminiKeyPool(keys, readConfig())
    _poolLoadedAt = now
  }
  return _pool
}

export const geminiPool = {
  async call<T>(fn: (ai: GoogleGenAI, keyId: string | null) => Promise<T>): Promise<T> {
    const pool = await getPoolAsync()
    return pool.call(fn)
  },
}
