// SERVER ONLY — runs live health-check probes against stored API keys and
// persists the verdict on each admin_config row.
//
// SECURITY:
// - Decrypted keys exist only in local memory for the duration of one probe.
// - Plaintext / ciphertext are NEVER logged or returned. Only the verdict
//   (healthy | unhealthy | unknown) + a short detail string are stored.
// - Uses the service-role client (same as the rest of lib/keys).

import { createServerClient } from '@/lib/supabase/server'
import { decryptSecret } from '@/lib/crypto'
import { logger } from '@/lib/logger'
import type { AdminConfigRow, MaskedAdminConfig } from '@/types/database'
import {
  getProbeConfig,
  classifyProbeResult,
  classifyProbeError,
  summarizeHealth,
  type HealthVerdict,
  type HealthSummary,
} from './healthcheck'

const PROBE_TIMEOUT_MS = 12_000

// Config keys we know how to probe. Matches the API allow-list.
const CHECKABLE_CONFIG_KEYS = [
  'gemini_api_key',
  'openai_api_key',
  'grok_api_key',
  'speechmatics_api_key',
] as const

// Columns needed to decrypt + identify a key. Ciphertext is used locally only.
const PROBE_SELECT =
  'id, config_key, value_ciphertext, value_iv, value_auth_tag'

type ProbeRow = Pick<
  AdminConfigRow,
  'id' | 'config_key' | 'value_ciphertext' | 'value_iv' | 'value_auth_tag'
>

/** Probe one provider with a decrypted key. Never throws — always a verdict. */
async function probeKey(configKey: string, plaintext: string): Promise<HealthVerdict> {
  const cfg = getProbeConfig(configKey)
  if (!cfg) return { status: 'unknown', detail: 'No probe configured for this provider' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const headers: Record<string, string> =
      cfg.authMode === 'bearer' ? { Authorization: `Bearer ${plaintext}` } : {}

    let body: string | undefined
    if (cfg.body) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(cfg.body)
    }

    const res = await fetch(cfg.url(plaintext), {
      method: cfg.method ?? 'GET',
      headers,
      body,
      signal: controller.signal,
    })

    const verdict = classifyProbeResult(res.status)

    // On success, just drain the body so the connection can be reused.
    if (res.status >= 200 && res.status < 300) {
      await res.body?.cancel().catch(() => {})
      return verdict
    }

    // On failure, capture a short snippet of the provider's error body and append
    // it to the detail — this surfaces the EXACT reason (e.g. which xAI ACL is
    // missing, or "no credits") instead of a generic status-code message.
    let snippet = ''
    try {
      snippet = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 200)
    } catch {
      // ignore — body may be unreadable; the status-based detail still stands
    }
    return snippet ? { ...verdict, detail: `${verdict.detail} — ${snippet}` } : verdict
  } catch (err) {
    return classifyProbeError(err)
  } finally {
    clearTimeout(timer)
  }
}

export interface HealthCheckRunResult {
  ranAt: string
  summary: HealthSummary
  keys: MaskedAdminConfig[]
}

/**
 * Run the health check across every stored key (active AND disabled), persist
 * each verdict, and return the masked rows + a summary.
 *
 * `ranAt` is a single timestamp shared by all rows updated in this run, so the
 * UI can show one "last checked" time.
 */
export async function runHealthCheck(): Promise<HealthCheckRunResult> {
  const db = createServerClient()
  const ranAt = new Date().toISOString()

  const { data: rows, error } = await db
    .from('admin_config')
    .select(PROBE_SELECT)
    .in('config_key', CHECKABLE_CONFIG_KEYS)

  if (error) {
    logger.error('[keys/healthcheck] failed to load keys', { detail: error.message })
    throw new Error('Failed to load keys for health check.')
  }

  const verdicts: HealthVerdict[] = []

  for (const row of (rows ?? []) as ProbeRow[]) {
    let verdict: HealthVerdict
    try {
      const plaintext = decryptSecret({
        ciphertext: row.value_ciphertext,
        iv:         row.value_iv,
        authTag:    row.value_auth_tag,
      })
      verdict = await probeKey(row.config_key, plaintext)
    } catch {
      // Decryption failure = the key can't be used (likely KEY_ENCRYPTION_SECRET
      // mismatch). That's a genuine unhealthy state, not a probe error.
      verdict = { status: 'unhealthy', detail: 'Stored key could not be decrypted' }
    }

    verdicts.push(verdict)

    const { error: updateErr } = await db
      .from('admin_config')
      .update({
        health_status:     verdict.status,
        health_detail:     verdict.detail,
        health_checked_at: ranAt,
      })
      .eq('id', row.id)

    if (updateErr) {
      logger.error('[keys/healthcheck] failed to persist verdict', {
        detail: updateErr.message,
      })
    }
  }

  const SAFE_SELECT =
    'id, created_at, config_key, label, last4, status, disabled_reason, last_used_at, health_status, health_checked_at, health_detail'
  const { data: refreshed } = await db
    .from('admin_config')
    .select(SAFE_SELECT)
    .in('config_key', CHECKABLE_CONFIG_KEYS)
    .order('config_key', { ascending: true })
    .order('created_at', { ascending: true })

  logger.info('[keys/healthcheck] run complete', {
    detail: JSON.stringify(summarizeHealth(verdicts)),
  })

  return {
    ranAt,
    summary: summarizeHealth(verdicts),
    keys: (refreshed ?? []) as unknown as MaskedAdminConfig[],
  }
}

/** Most recent health_checked_at across all keys, or null if never run. */
export async function getLastHealthCheckAt(): Promise<string | null> {
  const db = createServerClient()
  const { data } = await db
    .from('admin_config')
    .select('health_checked_at')
    .not('health_checked_at', 'is', null)
    .order('health_checked_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data?.health_checked_at as string | null) ?? null
}
