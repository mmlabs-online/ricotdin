// Pure helper for AIP-03 per-meeting model lock.
// No I/O — getDefaultGenerationModel() reads from the in-memory registry.

import { getDefaultGenerationModel } from '@/lib/ai/registry'
import type { ModelCtx } from './types'

/**
 * Resolve the generation model for a meeting.
 *
 * If the meeting already has a locked provider + model (stored at pipeline start),
 * reuse them verbatim.  Otherwise fall back to the system default and the caller
 * must persist the returned pair to the DB before starting generation.
 *
 * AIP-06 will replace getDefaultGenerationModel() with resolveGenerationModel(userId)
 * (PRF-08 → ADM-10 fallback chain).
 */
export function resolveModelLock(
  storedProvider: string | null | undefined,
  storedModel: string | null | undefined,
): ModelCtx {
  if (storedProvider && storedModel) {
    return { provider: storedProvider, model: storedModel }
  }
  const entry = getDefaultGenerationModel()
  return { provider: entry.provider, model: entry.model }
}
