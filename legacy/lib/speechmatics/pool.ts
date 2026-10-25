// SERVER ONLY — Speechmatics key pool singleton.
//
// Wraps SpeechmaticsKeyPool with 30-second TTL refresh so newly added DB keys
// take effect without a process restart.  In-flight counts reset on refresh;
// that's acceptable — they quickly self-correct as running jobs complete.
//
// Usage (start.ts):
//   const { apiKey, keyIndex } = await getSpeechmaticsPool().then(p => p.acquire())
//   // ... submit job with apiKey, store keyIndex in JobPayload
//
// Usage (transcribePoll.ts):
//   const sm = getSpeechmaticsPoolSync()
//   sm?.release(job.payload.speechmatics_key_index)

import { getActiveKeysWithMeta } from '@/lib/keys/provider'
import { SpeechmaticsKeyPool } from '@/lib/keys/speechmatics-pool'

const POOL_TTL_MS = 30_000

let _smPool:        SpeechmaticsKeyPool | null = null
let _smPoolLoadedAt = 0

export function resetSpeechmaticsPool(): void {
  _smPool = null
  _smPoolLoadedAt = 0
}

export async function getSpeechmaticsPoolAsync(): Promise<SpeechmaticsKeyPool> {
  const now = Date.now()
  if (!_smPool || now - _smPoolLoadedAt > POOL_TTL_MS) {
    const keys = await getActiveKeysWithMeta('speechmatics')
    _smPool = new SpeechmaticsKeyPool(keys)
    _smPoolLoadedAt = now
  }
  return _smPool
}

/** Synchronous access for release() calls in transcribePoll (no DB needed). */
export function getSpeechmaticsPoolSync(): SpeechmaticsKeyPool | null {
  return _smPool
}
