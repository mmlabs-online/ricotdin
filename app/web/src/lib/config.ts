// Runtime configuration (ARC-11). `config.json` is fetched at start, so one image serves staging
// and production: swap the file, not the build.

export type RuntimeConfig = {
  /** Origin of the v2 API (no path: the API is served at `/`). */
  apiUrl: string
  /** Origin that serves `/auth/*` (the refresh cookie is host-only, `Path=/auth`). Defaults to apiUrl. */
  authUrl: string
}

export class ConfigError extends Error {}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']) // same as deploy/15-ricotdin-config.envsh

function parseOrigin(name: string, raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() !== raw || raw === '') {
    throw new ConfigError(`${name} must be a URL string`)
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigError(`${name} is not a valid URL`)
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))
  if (!secure) throw new ConfigError(`${name} must use https (http only for localhost)`)
  if (url.username || url.password || url.search || url.hash || raw.includes('#') || raw.includes('?')) {
    throw new ConfigError(`${name} must be a plain origin`)
  }
  if (url.pathname !== '/') throw new ConfigError(`${name} must not have a path`)
  return url.origin
}

export function parseRuntimeConfig(raw: unknown): RuntimeConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('config.json must be a JSON object')
  }
  const body = raw as Record<string, unknown>
  const apiUrl = parseOrigin('apiUrl', body.apiUrl)
  const authUrl = body.authUrl === undefined ? apiUrl : parseOrigin('authUrl', body.authUrl)
  return { apiUrl, authUrl }
}

export async function loadRuntimeConfig(fetchFn: typeof fetch = fetch): Promise<RuntimeConfig> {
  const response = await fetchFn('/config.json', { cache: 'no-store', credentials: 'omit' })
  if (!response.ok) throw new ConfigError(`config.json: HTTP ${response.status}`)
  return parseRuntimeConfig(await response.json())
}
