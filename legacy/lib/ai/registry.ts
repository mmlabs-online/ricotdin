// Provider registry — the single source of truth for available generation models.
//
// AIP-01: Gemini entry.
// AIP-02: OpenAI entries (gpt-4o, gpt-4o-mini).
// AIP-06: getDefaultGenerationModel() will read from admin config (ADM-10).

import { GEMINI_MODEL } from '@/lib/gemini/client'
import { GeminiAdapter } from './adapters/gemini'
import { OpenAIAdapter } from './adapters/openai'
import type { OpenAIPool } from './adapters/openai'
import { grokPool, GROK_BASE_URL } from '@/lib/grok/pool'
import type { ProviderAdapter, CapabilityFlags } from './types'

// ---------------------------------------------------------------------------
// Registry types
// ---------------------------------------------------------------------------

export interface RegistryEntry {
  provider: string
  model: string
  adapter: ProviderAdapter
  capabilities: CapabilityFlags
}

// ---------------------------------------------------------------------------
// Registry singleton
// ---------------------------------------------------------------------------

const _registry = new Map<string, RegistryEntry>()

function _register(
  provider: string,
  model: string,
  adapter: ProviderAdapter,
  capabilities: CapabilityFlags,
): void {
  _registry.set(`${provider}:${model}`, { provider, model, adapter, capabilities })
}

// ── Gemini entry ─────────────────────────────────────────────────────────────
_register('gemini', GEMINI_MODEL, new GeminiAdapter(), {
  hardJsonSchema: true,
  acceptsAudio: false,
  maxContextTokens: 1_000_000,
})

// ── OpenAI entries (AIP-02) ───────────────────────────────────────────────────
// Both use the shared openAIPool singleton (default pool for OpenAIAdapter).
// Same adapter instance is safe — model is passed per-call, adapter is stateless.
const _openAIAdapter = new OpenAIAdapter()
_register('openai', 'gpt-4o', _openAIAdapter, {
  hardJsonSchema: true,
  acceptsAudio: false,
  maxContextTokens: 128_000,
})
_register('openai', 'gpt-4o-mini', _openAIAdapter, {
  hardJsonSchema: true,
  acceptsAudio: false,
  maxContextTokens: 128_000,
})

// ── Grok (xAI) entries ────────────────────────────────────────────────────────
// Grok's API is OpenAI-compatible, so it reuses OpenAIAdapter with the Grok pool
// (its own key type + api.x.ai base URL) and a 'grok' usage label. Model IDs track
// xAI's published names — adjust here if xAI renames a model (single-line change).
const _grokAdapter = new OpenAIAdapter(grokPool as unknown as OpenAIPool, GROK_BASE_URL, 'grok')
_register('grok', 'grok-4', _grokAdapter, {
  hardJsonSchema: true,
  acceptsAudio: false,
  maxContextTokens: 256_000,
})
_register('grok', 'grok-3-mini', _grokAdapter, {
  hardJsonSchema: true,
  acceptsAudio: false,
  maxContextTokens: 131_072,
})

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a provider+model pair to its adapter and capability flags.
 * Throws a clear error for unknown pairs so misconfiguration surfaces fast.
 */
export function resolveModel(provider: string, model: string): RegistryEntry {
  const entry = _registry.get(`${provider}:${model}`)
  if (!entry) {
    throw new Error(
      `Unknown provider/model: ${provider}:${model}. ` +
        `Registered: ${[..._registry.keys()].join(', ')}`,
    )
  }
  return entry
}

/**
 * Returns the default generation model for new requests.
 *
 * AIP-01: always returns the Gemini entry.
 * Used as the registry fallback; runtime default is now managed by resolveGenerationModel (AIP-06).
 */
export function getDefaultGenerationModel(): RegistryEntry {
  return resolveModel('gemini', GEMINI_MODEL)
}

/**
 * Return all registered provider+model entries.
 * Used by the admin config UI to display the allow-list and by the
 * AIP-06 resolver to validate stored preferences at call time.
 */
export function listRegistered(): RegistryEntry[] {
  return [..._registry.values()]
}
