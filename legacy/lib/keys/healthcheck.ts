// Pure health-check logic — no I/O, fully unit-testable.
//
// The live probe + DB writes live in ./healthcheck-runner.ts; the daily
// scheduler lives in ./healthScheduler.ts. This file only holds the decisions:
//   - which endpoint/auth to probe for a given config_key,
//   - how to turn an HTTP status (or a thrown error) into a health verdict,
//   - whether a scheduled run is due,
//   - how to summarise a batch of results.

export type HealthStatus = 'healthy' | 'unhealthy' | 'unknown'

export interface HealthVerdict {
  status: HealthStatus
  detail: string
}

export type AuthMode = 'bearer' | 'query'

export interface ProbeConfig {
  /** Build the probe URL for a plaintext key (query mode embeds the key). */
  url: (key: string) => string
  /** How the key is presented: Authorization: Bearer, or a URL query param. */
  authMode: AuthMode
  /** HTTP method. Defaults to GET when omitted. */
  method?: 'GET' | 'POST'
  /** JSON body (POST only). Sent with Content-Type: application/json. */
  body?: Record<string, unknown>
}

/** Interval between automated health-check runs (24 hours). */
export const HEALTH_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

// The cheapest Grok model — used only for the health probe's 1-token completion.
export const GROK_PROBE_MODEL = 'grok-3-mini'

// A cheap authenticated probe per provider.
//
// Gemini/OpenAI: listing models authenticates the key for free.
// Speechmatics: listing jobs does the same.
// Grok (xAI): keys use per-endpoint ACLs and by default CANNOT list models
//   (that needs the `api-key:endpoint:models` ACL), so `GET /v1/models` returns a
//   misleading 403 even for keys that work fine for chat. We instead probe the
//   endpoint the app actually uses — a minimal chat completion — so the verdict
//   reflects real usability. Costs ~1 output token per check.
const PROBES: Record<string, ProbeConfig> = {
  gemini_api_key: {
    authMode: 'query',
    url: (key) =>
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
  },
  openai_api_key: {
    authMode: 'bearer',
    url: () => 'https://api.openai.com/v1/models',
  },
  grok_api_key: {
    authMode: 'bearer',
    method: 'POST',
    url: () => 'https://api.x.ai/v1/chat/completions',
    body: {
      model: GROK_PROBE_MODEL,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    },
  },
  speechmatics_api_key: {
    authMode: 'bearer',
    url: () => 'https://asr.api.speechmatics.com/v2/jobs?limit=1',
  },
}

/** Return the probe config for a config_key, or null if unsupported. */
export function getProbeConfig(configKey: string): ProbeConfig | null {
  return PROBES[configKey] ?? null
}

/**
 * Map an HTTP status from the probe into a health verdict.
 *
 * - 2xx           → healthy (key authenticated)
 * - 429           → healthy (rate-limited, but the rate limit is applied AFTER
 *                   auth — so the key is definitively valid)
 * - 401           → unhealthy (invalid / revoked key)
 * - 403           → unhealthy (key rejected: no permission for this API)
 * - 5xx           → unknown  (provider-side outage, not the key's fault)
 * - anything else → unknown  (e.g. 400 — probe request issue, inconclusive)
 */
export function classifyProbeResult(httpStatus: number): HealthVerdict {
  if (httpStatus >= 200 && httpStatus < 300) {
    return { status: 'healthy', detail: `OK (${httpStatus})` }
  }
  if (httpStatus === 429) {
    return { status: 'healthy', detail: 'Rate-limited (429) — key is valid' }
  }
  if (httpStatus === 401) {
    return { status: 'unhealthy', detail: 'Rejected: invalid or revoked key (401)' }
  }
  if (httpStatus === 403) {
    return { status: 'unhealthy', detail: 'Rejected: key lacks permission (403)' }
  }
  if (httpStatus >= 500) {
    return { status: 'unknown', detail: `Provider error (${httpStatus}) — inconclusive` }
  }
  return { status: 'unknown', detail: `Unexpected response (${httpStatus}) — inconclusive` }
}

/** A thrown network/TLS error means we could not reach the provider — inconclusive. */
export function classifyProbeError(err: unknown): HealthVerdict {
  const msg = err instanceof Error ? err.message : String(err)
  return { status: 'unknown', detail: `Network error — inconclusive: ${msg.slice(0, 120)}` }
}

/**
 * Decide whether an automated run is due.
 * Due when there has never been a run, or the last run is older than intervalMs.
 */
export function isHealthCheckDue(
  lastRunISO: string | null,
  nowMs: number,
  intervalMs: number = HEALTH_CHECK_INTERVAL_MS,
): boolean {
  if (!lastRunISO) return true
  const last = Date.parse(lastRunISO)
  if (Number.isNaN(last)) return true
  return nowMs - last >= intervalMs
}

export interface HealthResultLike {
  status: HealthStatus
}

export interface HealthSummary {
  total: number
  healthy: number
  unhealthy: number
  unknown: number
}

/** Count verdicts by status for a batch of probe results. */
export function summarizeHealth(results: HealthResultLike[]): HealthSummary {
  const summary: HealthSummary = { total: results.length, healthy: 0, unhealthy: 0, unknown: 0 }
  for (const r of results) summary[r.status]++
  return summary
}
