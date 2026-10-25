// SERVER ONLY — reads the Speechmatics API key from the DB key pool (with env fallback).
// Import only from /app/api or server /lib.

import { getActiveKeys } from '@/lib/keys/provider'

const BASE_URL = 'https://asr.api.speechmatics.com'

async function getApiKey(): Promise<string> {
  const keys = await getActiveKeys('speechmatics')
  if (keys.length === 0) {
    throw new Error(
      'No active Speechmatics API key found. ' +
      'Add one via the admin keys UI or set SPEECHMATICS_API_KEY in the environment.',
    )
  }
  return keys[0]
}

// Transient low-level network errors worth retrying. These surface from
// `fetch` as a thrown TypeError whose `.cause.code` carries the real reason.
// A corporate TLS-inspecting proxy in front of this machine intermittently
// resets connections (ECONNRESET) even when TLS itself verifies fine.
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
])

const MAX_ATTEMPTS = 8
const BASE_BACKOFF_MS = 600
const MAX_BACKOFF_MS = 10_000

// Exponential backoff for retry `attempt` (1-based), capped so later attempts
// don't balloon: 0.6s, 1.2s, 2.4s, 4.8s, 9.6s, then 10s, 10s, …
const backoffMs = (attempt: number) =>
  Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS)

function isTransientNetworkError(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string; message?: string } } | undefined)?.cause
  const code = cause?.code
  if (code && TRANSIENT_CODES.has(code)) return true
  const msg = `${(err as Error)?.message ?? ''} ${cause?.message ?? ''}`.toLowerCase()
  return msg.includes('socket hang up') || msg.includes('econnreset')
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Make an authenticated request to the Speechmatics API.
 * Throws on non-2xx responses with the status code and body text included.
 *
 * Retries transient network failures (proxy resets / timeouts) and 429 / 5xx
 * responses with exponential backoff. Pass `body` as FormData for multipart
 * endpoints (job submission) or as a string for JSON bodies; omit for GET.
 *
 * Pass `apiKey` to skip the pool lookup (used by the job pool to thread the
 * acquired key through all requests for the same job).
 */
export async function speechmaticsRequest<T>(
  method: string,
  path: string,
  body?: FormData | string,
  apiKey?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey ?? (await getApiKey())}`,
  }

  // Only set Content-Type for string bodies; FormData sets its own boundary.
  if (typeof body === 'string') {
    headers['Content-Type'] = 'application/json'
  }

  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}${path}`, { method, headers, body })

      // Retry server-side transient statuses.
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
        await res.body?.cancel().catch(() => {})
        lastErr = new Error(`Speechmatics API ${method} ${path} returned ${res.status}`)
        await sleep(backoffMs(attempt))
        continue
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(
          `Speechmatics API ${method} ${path} failed with ${res.status}: ${text.slice(0, 300)}`,
        )
      }

      return res.json() as Promise<T>
    } catch (err) {
      lastErr = err
      // Only retry transient network errors; surface real failures immediately.
      if (attempt < MAX_ATTEMPTS && isTransientNetworkError(err)) {
        await sleep(backoffMs(attempt))
        continue
      }
      throw err
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error(`Speechmatics API ${method} ${path} failed after ${MAX_ATTEMPTS} attempts`)
}
