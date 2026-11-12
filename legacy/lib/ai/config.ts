// SERVER ONLY.
// AIP-06: system-wide generation config (ADM-10) and model allow-list helpers.
// Reads from `app_settings` table with a 30-second TTL in-memory cache.

import { createServerClient } from '@/lib/supabase/server'
import { resolveModel } from './registry'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelPick {
  provider: string
  model: string
}

export interface GenerationConfig {
  systemDefault: ModelPick
  allowedModels: ModelPick[]
}

// ---------------------------------------------------------------------------
// TTL cache
// ---------------------------------------------------------------------------

const TTL_MS = 30_000

let _cache: { config: GenerationConfig; expiresAt: number } | null = null

export function invalidateConfigCache(): void {
  _cache = null
}

// ---------------------------------------------------------------------------
// DB read
// ---------------------------------------------------------------------------

const FALLBACK: GenerationConfig = {
  systemDefault: { provider: 'gemini', model: 'gemini-2.5-flash' },
  allowedModels: [{ provider: 'gemini', model: 'gemini-2.5-flash' }],
}

export async function getGenerationConfig(): Promise<GenerationConfig> {
  const now = Date.now()
  if (_cache && _cache.expiresAt > now) return _cache.config

  const db = createServerClient()
  const { data } = await db
    .from('app_settings')
    .select('key, value')
    .in('key', ['generation.system_default', 'generation.allowed_models'])

  if (!data?.length) {
    _cache = { config: FALLBACK, expiresAt: now + TTL_MS }
    return FALLBACK
  }

  const rows: Record<string, unknown> = Object.fromEntries(
    (data as Array<{ key: string; value: unknown }>).map((r) => [r.key, r.value]),
  )

  const sd = rows['generation.system_default'] as ModelPick | undefined
  const am = rows['generation.allowed_models'] as ModelPick[] | undefined

  const config: GenerationConfig = {
    systemDefault: sd ?? FALLBACK.systemDefault,
    allowedModels: Array.isArray(am) ? am : FALLBACK.allowedModels,
  }

  _cache = { config, expiresAt: now + TTL_MS }
  return config
}

/**
 * Read and immediately save the config (used by admin PATCH route).
 * Invalidates the cache after writing.
 */
export async function saveGenerationConfig(
  patch: Partial<GenerationConfig>,
  updatedBy: string | null,
): Promise<void> {
  const db = createServerClient()
  const upserts: Array<{ key: string; value: unknown; updated_by: string | null }> = []

  if (patch.systemDefault) {
    upserts.push({ key: 'generation.system_default', value: patch.systemDefault, updated_by: updatedBy })
  }
  if (patch.allowedModels) {
    upserts.push({ key: 'generation.allowed_models', value: patch.allowedModels, updated_by: updatedBy })
  }

  for (const row of upserts) {
    const { error } = await db
      .from('app_settings')
      .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    if (error) throw new Error(`saveGenerationConfig failed for ${row.key}: ${error.message}`)
  }

  invalidateConfigCache()
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O)
// ---------------------------------------------------------------------------

/**
 * True when the provider:model pair is BOTH in the allow-list AND present in
 * the in-memory registry (so it can actually be used at call time).
 */
export function isModelAllowed(
  provider: string,
  model: string,
  config: GenerationConfig,
): boolean {
  const inList = config.allowedModels.some(
    (m) => m.provider === provider && m.model === model,
  )
  if (!inList) return false
  try {
    resolveModel(provider, model)
    return true
  } catch {
    return false
  }
}

/**
 * Load the user's stored model preference from the profiles table.
 * Returns null when the user has no preference set or userId is absent.
 */
export async function loadUserModelPref(
  userId: string | null | undefined,
): Promise<ModelPick | null> {
  if (!userId) return null
  const db = createServerClient()
  const { data } = await db
    .from('profiles')
    .select('default_provider, default_model')
    .eq('id', userId)
    .maybeSingle()
  if (!data?.default_provider || !data?.default_model) return null
  return { provider: data.default_provider, model: data.default_model }
}
