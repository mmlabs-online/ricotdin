import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IncomingHttpHeaders } from 'node:http'
import type { Plugin, ProxyOptions } from 'vite'

/**
 * Dev only (OPS-08): with `RICOTDIN_DEV_TOKEN=1 npm run dev`, the dev server proxies `/__dev_api/*`
 * (prefix stripped) and `/media` to the local API and adds an mmlabs bearer token on the Node side.
 * The token comes from a file written by scripts/dev-token.sh and is read on every request; it never
 * reaches the browser, build-time env variables or `dist/`. The dev server also answers `/config.json`
 * so the SPA talks to the proxy (src/lib/devConfig.ts) and skips the mmlabs sign-in (src/auth/devSession.ts).
 * Ported from tudocuatui (T-025).
 */

export type TokenResult = { status: 'ok'; token: string } | { status: 'missing' | 'malformed' | 'expired' }

export const DEV_API_PREFIX = '/__dev_api'
/** Matches /__dev_api, /__dev_api/..., /__dev_api?... only. */
export const PROXY_KEY = '^/__dev_api(/|\\?|$)'
/** The `/media` playback link resolves to the origin root (mediaSrc), so it is proxied as is. */
export const MEDIA_KEY = '^/media(\\?|$)'
export const DEFAULT_TARGET = 'http://127.0.0.1:8000'

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
/** Hosts the SPA config accepts over http (src/lib/config.ts LOCAL_HOSTS). */
const DEV_HOST = /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/

/** The proxy adds a real bearer token, so it may only talk to a loopback backend. */
export function proxyTarget(env: NodeJS.ProcessEnv): string {
  const target = env.RICOTDIN_DEV_API || DEFAULT_TARGET
  let hostname: string
  try {
    hostname = new URL(target).hostname
  } catch {
    throw new Error('[dev-token] RICOTDIN_DEV_API is not a valid URL')
  }
  if (!LOOPBACK.has(hostname)) {
    throw new Error('[dev-token] RICOTDIN_DEV_API must point to 127.0.0.1, localhost or ::1')
  }
  return target
}

/** The dev server must not be reachable from the network while it adds the bearer token. */
export function assertLocalServer(server: { host?: string | boolean; allowedHosts?: unknown }): void {
  const host = server.host
  // Not ::1: the SPA config accepts http only for localhost / 127.0.0.1.
  if (host !== undefined && host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error('[dev-token] the dev server must listen on 127.0.0.1 or localhost (no --host)')
  }
  if (server.allowedHosts === true) {
    throw new Error('[dev-token] server.allowedHosts: true is not allowed with the dev token proxy')
  }
}

/** Default is outside the repo, so git and Docker never see it. */
export function tokenFilePath(env: NodeJS.ProcessEnv, homedir: string): string {
  return env.RICOTDIN_DEV_TOKEN_FILE || path.join(homedir, '.config', 'ricotdin', 'dev-token')
}

function expOf(token: string): number | null {
  try {
    const payload: unknown = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
    const exp = typeof payload === 'object' && payload !== null ? (payload as { exp?: unknown }).exp : undefined
    return typeof exp === 'number' ? exp : null
  } catch {
    return null
  }
}

/** Synchronous on purpose: read per request, so a refreshed token needs no restart. */
export function readDevToken(file: string, nowMs: number): TokenResult {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8').trim()
  } catch {
    return { status: 'missing' }
  }
  if (!JWT_SHAPE.test(raw)) return { status: 'malformed' }
  const exp = expOf(raw)
  if (exp === null) return { status: 'malformed' }
  if (exp * 1000 <= nowMs) return { status: 'expired' }
  return { status: 'ok', token: raw }
}

/** The client's Authorization is always dropped. The bearer is set only for a valid token on a
 * same-origin browser request (`Sec-Fetch-Site: same-origin`; a missing header gets none, so old
 * browsers and other local processes cannot borrow it; curl must send the header on purpose), to a
 * local Host (no tunnel, no DNS rebinding), with a matching Origin when one is sent. */
export function rewriteAuth(headers: IncomingHttpHeaders, result: TokenResult): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = { ...headers }
  delete out.authorization
  const host = headers.host
  const origin = headers.origin
  const allowed =
    result.status === 'ok' &&
    headers['sec-fetch-site'] === 'same-origin' &&
    host !== undefined &&
    DEV_HOST.test(host) &&
    (origin === undefined || origin === `http://${host}`)
  if (allowed) out.authorization = `Bearer ${result.token}`
  return out
}

export function warningFor(result: TokenResult): string | null {
  if (result.status === 'ok') return null
  return `[dev-token] token ${result.status} - run scripts/dev-token.sh`
}

export function stripPrefix(url: string): string {
  if (!url.startsWith(DEV_API_PREFIX)) return url
  const rest = url.slice(DEV_API_PREFIX.length)
  return rest.startsWith('/') ? rest : `/${rest}`
}

/** `/config.json` for the dev server at `host` (the request's Host header); null = not a local host. */
export function devConfig(host: string | undefined): { apiUrl: string; authUrl: string; devProxy: string } | null {
  if (!host || !DEV_HOST.test(host)) return null
  const port = host.split(':')[1]
  if (port !== undefined && Number(port) > 65535) return null
  const origin = `http://${host}`
  return { apiUrl: origin, authUrl: origin, devProxy: DEV_API_PREFIX }
}

export function devTokenProxy(): Plugin {
  const file = tokenFilePath(process.env, os.homedir())
  let lastWarning: string | null = null
  const configure: ProxyOptions['configure'] = (proxy) => {
    proxy.on('proxyReq', (proxyReq, req) => {
      const result = readDevToken(file, Date.now())
      const warning = warningFor(result)
      if (warning !== lastWarning) {
        lastWarning = warning
        if (warning) console.error(warning)
      }
      const out = rewriteAuth(req.headers, result)
      proxyReq.removeHeader('authorization')
      if (out.authorization) proxyReq.setHeader('authorization', out.authorization)
    })
  }
  return {
    name: 'ricotdin-dev-token-proxy',
    apply: (_config, env) => env.command === 'serve' && !env.isPreview && process.env.RICOTDIN_DEV_TOKEN === '1',
    configResolved(config) {
      assertLocalServer(config.server)
    },
    config() {
      const target = proxyTarget(process.env)
      return {
        server: {
          proxy: {
            [PROXY_KEY]: { target, rewrite: stripPrefix, configure },
            [MEDIA_KEY]: { target, configure },
          },
        },
      }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/config.json') return next()
        const body = devConfig(req.headers.host)
        res.setHeader('Cache-Control', 'no-store')
        if (!body) {
          res.statusCode = 400
          res.end()
          return
        }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(body))
      })
    },
  }
}
