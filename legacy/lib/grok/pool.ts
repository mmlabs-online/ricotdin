// SERVER ONLY — reads Grok (xAI) API keys via the pool. Never import from client components.
//
// Grok's API is OpenAI-compatible (chat.completions + json_schema structured
// outputs), so it reuses the OpenAI KeyPool machinery via createTtlPool — the
// only differences are the key type ('grok') and the base URL (api.x.ai).
//
// Docs: https://docs.x.ai/docs  — base URL https://api.x.ai/v1, Bearer auth.

import { createTtlPool } from '@/lib/openai/pool'

export const GROK_BASE_URL = 'https://api.x.ai/v1'

/** Shared Grok pool singleton (30s TTL key refresh, env-var fallback). */
export const grokPool = createTtlPool('grok', GROK_BASE_URL)

/** Force an immediate key refresh (call after key mutations). */
export function resetGrokPool(): void {
  grokPool.reset()
}
