// SERVER ONLY — loads active config values from admin_config, with in-memory cache
// and env-var fallback.
//
// Cache: per config_key, 30-second TTL. Invalidated immediately after mutations.
// Fallback: env vars are used when no active DB rows exist for a config_key.

import { createServerClient } from '@/lib/supabase/server'
import { decryptSecret } from '@/lib/crypto'
import { logger } from '@/lib/logger'

const KEY_CACHE_TTL_MS = 30_000

const PROVIDER_CONFIG_KEY: Record<string, string> = {
  gemini:       'gemini_api_key',
  speechmatics: 'speechmatics_api_key',
  openai:       'openai_api_key',
  grok:         'grok_api_key',
}

function toConfigKey(provider: string): string {
  return PROVIDER_CONFIG_KEY[provider] ?? `${provider}_api_key`
}

export type KeyWithMeta = { id: string | null; key: string }

type CacheEntry = { entries: KeyWithMeta[]; expiresAt: number }
const _cache = new Map<string, CacheEntry>()

/** Env-var fallback keys (no DB id). */
function envKeys(provider: string): KeyWithMeta[] {
  if (provider === 'gemini') {
    const seen = new Set<string>()
    const out: KeyWithMeta[] = []
    const push = (raw?: string) => {
      const t = raw?.trim()
      if (t && !seen.has(t)) { seen.add(t); out.push({ id: null, key: t }) }
    }
    const csv = process.env.GEMINI_API_KEYS
    if (csv) csv.split(',').forEach(push)
    for (let i = 1; i <= 20; i++) push(process.env[`GEMINI_API_KEY_${i}`])
    push(process.env.GEMINI_API_KEY)
    return out
  }
  if (provider === 'speechmatics') {
    const k = process.env.SPEECHMATICS_API_KEY?.trim()
    return k ? [{ id: null, key: k }] : []
  }
  if (provider === 'openai') {
    const k = process.env.OPENAI_API_KEY?.trim()
    return k ? [{ id: null, key: k }] : []
  }
  if (provider === 'grok') {
    const k = process.env.GROK_API_KEY?.trim() || process.env.XAI_API_KEY?.trim()
    return k ? [{ id: null, key: k }] : []
  }
  return []
}

async function loadEntries(provider: string): Promise<KeyWithMeta[]> {
  const configKey = toConfigKey(provider)
  const entries: KeyWithMeta[] = []

  try {
    const db = createServerClient()
    const { data } = await db
      .from('admin_config')
      .select('id, value_ciphertext, value_iv, value_auth_tag')
      .eq('config_key', configKey)
      .eq('status', 'active')
      .order('created_at', { ascending: true })

    if (data && data.length > 0) {
      for (const row of data) {
        try {
          entries.push({
            id: row.id as string,
            key: decryptSecret({
              ciphertext: row.value_ciphertext as string,
              iv:         row.value_iv as string,
              authTag:    row.value_auth_tag as string,
            }),
          })
        } catch {
          logger.error(`[keys] failed to decrypt admin_config row (${configKey})`, { detail: String(row.id) })
        }
      }
    }
  } catch (err) {
    logger.error(`[keys] DB lookup failed for config_key "${toConfigKey(provider)}"`, { detail: String(err) })
  }

  return entries.length > 0 ? entries : envKeys(provider)
}

/**
 * Return active keys with their DB IDs (null for env-var fallback keys).
 * Cached for 30 s; call invalidateKeyCache() after mutations.
 */
export async function getActiveKeysWithMeta(provider: string): Promise<KeyWithMeta[]> {
  const configKey = toConfigKey(provider)
  const now = Date.now()

  const cached = _cache.get(configKey)
  if (cached && cached.expiresAt > now) return cached.entries

  const entries = await loadEntries(provider)
  _cache.set(configKey, { entries, expiresAt: now + KEY_CACHE_TTL_MS })
  return entries
}

/**
 * Return decrypted active keys (plaintext only) for the given provider.
 * Falls back to env vars when no DB rows exist.
 */
export async function getActiveKeys(provider: string): Promise<string[]> {
  return (await getActiveKeysWithMeta(provider)).map(k => k.key)
}

/** Expire the cache for a provider (or all providers). Call after key mutations. */
export function invalidateKeyCache(provider?: string): void {
  if (provider) _cache.delete(toConfigKey(provider))
  else _cache.clear()
}
