// SERVER ONLY — reads OpenAI API keys via the pool. Never import from client components.
//
// Multi-key pool with LRU selection, per-key cooldown tracking, and automatic
// rotation on 429 / 5xx / network errors — via the generic KeyPool<C> base.
//
// OpenAI-specific error normalisation (applied before KeyPool sees the error):
//
//   insufficient_quota  The key is out of credits. Unlike a transient 429 rate-limit,
//                       this key will never succeed again without billing action.
//                       Reclassified as "401 API_KEY_INVALID" so KeyPool permanently
//                       disables the key and rotates to the next one.
//
//   RefusalError        Model declined to respond (message.refusal was set).
//                       Surfaced immediately without key rotation via isNonRetryable.
//                       Name-check used to avoid circular import with the adapter.

import OpenAI from 'openai'
import { KeyPool, AllKeysExhaustedError } from '@/lib/keys/pool'
import type { PoolConfig } from '@/lib/keys/pool'
import { getActiveKeysWithMeta } from '@/lib/keys/provider'

export { AllKeysExhaustedError }

function readConfig(): PoolConfig {
  const n = (key: string, fallback: number) =>
    parseInt(process.env[key] ?? '', 10) || fallback
  return {
    defaultCooldownMs: n('OPENAI_DEFAULT_COOLDOWN_MS', 60_000),
    baseBackoffMs:     n('OPENAI_BASE_BACKOFF_MS', 500),
    maxBackoffMs:      n('OPENAI_MAX_BACKOFF_MS', 8_000),
    maxAttempts:       n('OPENAI_MAX_ATTEMPTS', 0),
    maxCooldownWaitMs: n('OPENAI_MAX_COOLDOWN_WAIT_MS', 30_000),
  }
}

function isInsufficientQuota(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  if (/insufficient_quota/i.test(msg)) return true
  const body = (err as Record<string, unknown> | null)?.['error']
  if (typeof body === 'object' && body !== null) {
    const b = body as Record<string, unknown>
    if (b['code'] === 'insufficient_quota' || b['type'] === 'insufficient_quota') return true
  }
  return false
}

class OpenAIKeyPool {
  private readonly pool: KeyPool<OpenAI>

  constructor(
    keys: Array<{ id: string | null; key: string }>,
    cfg: PoolConfig,
    baseURL?: string,
  ) {
    this.pool = new KeyPool<OpenAI>(
      keys,
      (key) => new OpenAI({ apiKey: key, ...(baseURL ? { baseURL } : {}) }),
      'openai',
      cfg,
      // Surface RefusalError immediately — model declined, rotating keys won't help.
      // Name check avoids a circular import with lib/ai/adapters/openai.
      (err) => err instanceof Error && err.name === 'RefusalError',
    )
  }

  async call<T>(fn: (client: OpenAI, keyId: string | null) => Promise<T>): Promise<T> {
    return this.pool.call(async (client, keyId) => {
      try {
        return await fn(client, keyId)
      } catch (err) {
        // Reclassify insufficient_quota → permanent key disable (not just cooldown).
        if (isInsufficientQuota(err)) {
          const msg = err instanceof Error ? err.message : String(err)
          throw new Error(`401 API_KEY_INVALID (key quota exhausted): ${msg}`)
        }
        throw err
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Singleton with 30-second TTL refresh.
// resetOpenAIPool() forces an immediate refresh (call after key mutations).
// ---------------------------------------------------------------------------

const POOL_TTL_MS = 30_000
let _pool: OpenAIKeyPool | null = null
let _poolLoadedAt = 0

export function resetOpenAIPool(): void {
  _pool = null
  _poolLoadedAt = 0
}

async function getPoolAsync(): Promise<OpenAIKeyPool> {
  const now = Date.now()
  if (!_pool || now - _poolLoadedAt > POOL_TTL_MS) {
    const keys = await getActiveKeysWithMeta('openai')
    _pool = new OpenAIKeyPool(keys, readConfig())
    _poolLoadedAt = now
  }
  return _pool
}

export const openAIPool = {
  async call<T>(fn: (client: OpenAI, keyId: string | null) => Promise<T>): Promise<T> {
    const pool = await getPoolAsync()
    return pool.call(fn)
  },
}

/** Create a pool bound to a specific base URL (for OpenAI-compatible providers). */
export async function createOpenAIPool(baseURL: string): Promise<{
  call<T>(fn: (client: OpenAI, keyId: string | null) => Promise<T>): Promise<T>
}> {
  const keys = await getActiveKeysWithMeta('openai')
  const p = new OpenAIKeyPool(keys, readConfig(), baseURL)
  return p
}

// ---------------------------------------------------------------------------
// Generic TTL-cached pool for any OpenAI-compatible provider (Grok, Kimi, …).
// Reads that provider's own key type via getActiveKeysWithMeta(provider) and
// binds the given base URL. Each returned pool keeps its own 30-second TTL
// singleton and a reset() to force an immediate refresh after key mutations.
// ---------------------------------------------------------------------------

export interface TtlPool {
  call<T>(fn: (client: OpenAI, keyId: string | null) => Promise<T>): Promise<T>
  reset(): void
}

export function createTtlPool(provider: string, baseURL?: string): TtlPool {
  let pool: OpenAIKeyPool | null = null
  let loadedAt = 0

  async function get(): Promise<OpenAIKeyPool> {
    const now = Date.now()
    if (!pool || now - loadedAt > POOL_TTL_MS) {
      const keys = await getActiveKeysWithMeta(provider)
      pool = new OpenAIKeyPool(keys, readConfig(), baseURL)
      loadedAt = now
    }
    return pool
  }

  return {
    async call<T>(fn: (client: OpenAI, keyId: string | null) => Promise<T>): Promise<T> {
      return (await get()).call(fn)
    },
    reset(): void {
      pool = null
      loadedAt = 0
    },
  }
}
