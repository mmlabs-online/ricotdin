// Job-aware Speechmatics key pool (least-active-count balancing).
//
// Unlike the stateless LRU rotation in KeyPool<C>, each Speechmatics API call
// maps to a long-lived asynchronous job that spans multiple HTTP requests
// (submit → poll → fetch-transcript).  The pool must track which key is
// holding which job so we can:
//   1. Send all requests for the same job on the same key.
//   2. Release the key's slot when the job finishes (or fails).
//
// Strategy: least-active-count.  Each key tracks a count of in-flight jobs.
// acquire() picks the key with the fewest in-flight jobs and increments its
// count.  release(keyIndex) decrements it when the job finishes.
//
// With a single key the pool degenerates to "always that key" (keyIndex=0,
// no balancing — identical to the old getApiKey() behaviour).
//
// In-memory counts reset on process restart.  That's acceptable for job load
// balancing — the counts quickly self-correct once in-flight jobs complete.

import { logger } from '@/lib/logger'

export interface KeyWithMeta {
  id: string | null
  key: string
}

export interface AcquiredKey {
  apiKey: string
  keyId: string | null
  keyIndex: number
}

export class SpeechmaticsKeyPool {
  private readonly keys: Array<{ id: string | null; key: string; inFlight: number }>

  constructor(keys: KeyWithMeta[]) {
    if (keys.length === 0) {
      throw new Error(
        'No Speechmatics API keys configured. ' +
          'Set SPEECHMATICS_API_KEY or add a key via the admin UI.',
      )
    }
    this.keys = keys.map(k => ({ ...k, inFlight: 0 }))
    logger.info('[speechmatics pool] initialised', { count: keys.length })
  }

  /** Returns the key with the fewest in-flight jobs and increments its counter. */
  acquire(): AcquiredKey {
    const chosen = this.keys.reduce((best, k, i) =>
      k.inFlight < this.keys[best].inFlight ? i : best,
      0,
    )
    this.keys[chosen].inFlight++
    return {
      apiKey:   this.keys[chosen].key,
      keyId:    this.keys[chosen].id,
      keyIndex: chosen,
    }
  }

  /** Decrements the in-flight counter for the key at `keyIndex`. Safe to call multiple times. */
  release(keyIndex: number): void {
    if (keyIndex < 0 || keyIndex >= this.keys.length) {
      logger.warn('[speechmatics pool] release: out-of-range index', { keyIndex })
      return
    }
    this.keys[keyIndex].inFlight = Math.max(0, this.keys[keyIndex].inFlight - 1)
  }

  /** Total keys in the pool (for diagnostics). */
  get size(): number {
    return this.keys.length
  }

  /** In-flight count for a specific key (for tests and diagnostics). */
  inFlightCount(keyIndex: number): number {
    return this.keys[keyIndex]?.inFlight ?? 0
  }
}
