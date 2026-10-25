// SERVER ONLY — reads feature flags / settings from `app_config`.
//
// `app_config` is admin-SELECT under RLS, so the browser can never read it
// directly. Routes that need a flag read it here (service-role client) and hand
// the resolved value to the client as part of an existing response.
//
// Cache: per key, 30-second TTL — same shape as lib/keys/provider.ts. A flag
// flipped in /admin/config takes effect within 30s without a restart.

import { createServerClient } from '@/lib/supabase/server'
import { coerceConfigBool } from '@/lib/admin/config'
import { logger } from '@/lib/logger'

const CONFIG_CACHE_TTL_MS = 30_000

type CacheEntry = { value: unknown; expiresAt: number }
const _cache = new Map<string, CacheEntry>()

/**
 * Raw `app_config.value` for `key`, or undefined when the row is missing or the
 * lookup fails. A read failure is never fatal — callers fall back to a default.
 */
export async function getAppConfigValue(key: string): Promise<unknown> {
  const now = Date.now()
  const hit = _cache.get(key)
  if (hit && hit.expiresAt > now) return hit.value

  let value: unknown
  try {
    const db = createServerClient()
    const { data, error } = await db
      .from('app_config')
      .select('value')
      .eq('key', key)
      .maybeSingle()

    if (error) throw new Error(error.message)
    value = (data as { value?: unknown } | null)?.value
  } catch (err) {
    logger.warn('[app-config] lookup failed — using caller default', {
      detail: `${key}: ${String(err)}`,
    })
    value = undefined
  }

  _cache.set(key, { value, expiresAt: now + CONFIG_CACHE_TTL_MS })
  return value
}

/** Boolean flag lookup. Returns `fallback` when the row is absent or malformed. */
export async function getAppConfigBool(key: string, fallback: boolean): Promise<boolean> {
  return coerceConfigBool(await getAppConfigValue(key), fallback)
}

/** Drop cached values so the next read hits the DB. Called after a config PATCH. */
export function invalidateAppConfigCache(key?: string): void {
  if (key) _cache.delete(key)
  else _cache.clear()
}
