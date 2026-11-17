// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TARGET,
  DEV_API_PREFIX,
  MEDIA_KEY,
  PROXY_KEY,
  assertLocalServer,
  devConfig,
  devTokenProxy,
  proxyTarget,
  readDevToken,
  rewriteAuth,
  stripPrefix,
  tokenFilePath,
  warningFor,
} from './devTokenProxy'

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)
const jwt = (exp: number) =>
  [
    Buffer.from('{"alg":"none"}').toString('base64url'),
    Buffer.from(JSON.stringify({ exp })).toString('base64url'),
    'sig_-x',
  ].join('.')
const FRESH = jwt(NOW / 1000 + 600)
const STALE = jwt(NOW / 1000 - 5)

const tmpDirs: string[] = []
function tokenFile(content: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ricotdin-dev-'))
  tmpDirs.push(dir)
  const file = path.join(dir, 'dev-token')
  if (content !== null) fs.writeFileSync(file, content)
  return file
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

type ProxyRule = {
  target: string
  rewrite?: (p: string) => string
  configure: (p: { on: (e: string, cb: unknown) => void }) => void
}
const proxyOf = (plugin: ReturnType<typeof devTokenProxy>) =>
  (plugin.config as () => { server: { proxy: Record<string, ProxyRule> } })().server.proxy

describe('devTokenProxy plugin', () => {
  const apply = (env: Record<string, unknown>) =>
    (devTokenProxy().apply as (c: unknown, e: unknown) => boolean)({}, env)

  it('applies only to serve with RICOTDIN_DEV_TOKEN=1; never build or preview', () => {
    const serve = { command: 'serve', isPreview: false }
    expect(apply(serve)).toBe(false)
    vi.stubEnv('RICOTDIN_DEV_TOKEN', '1')
    expect(apply(serve)).toBe(true)
    expect(apply({ command: 'build', isPreview: false })).toBe(false)
    expect(apply({ command: 'serve', isPreview: true })).toBe(false)
    vi.stubEnv('RICOTDIN_DEV_TOKEN', 'true')
    expect(apply(serve)).toBe(false)
  })

  it('proxy rules: /__dev_api and /__dev_api/...; /media and /media?...; nothing else', () => {
    const api = new RegExp(PROXY_KEY)
    for (const ok of ['/__dev_api', '/__dev_api/meetings', '/__dev_api/auth/me?x=1']) expect(api.test(ok)).toBe(true)
    for (const no of ['/__dev_apix', '/meetings', '/src/__dev_api.ts', '/']) expect(api.test(no)).toBe(false)
    const media = new RegExp(MEDIA_KEY)
    for (const ok of ['/media', '/media?t=abc']) expect(media.test(ok)).toBe(true)
    for (const no of ['/medias', '/media/x', '/src/media.ts', '/meetings/media']) expect(media.test(no)).toBe(false)
  })

  it('registers exactly the two rules, both to the target; the API rule strips the prefix', () => {
    const proxy = proxyOf(devTokenProxy())
    expect(Object.keys(proxy)).toEqual([PROXY_KEY, MEDIA_KEY])
    expect(proxy[PROXY_KEY]?.target).toBe(DEFAULT_TARGET)
    expect(proxy[MEDIA_KEY]?.target).toBe(DEFAULT_TARGET)
    expect(proxy[PROXY_KEY]?.rewrite?.('/__dev_api/meetings?x=1')).toBe('/meetings?x=1')
    expect(proxy[MEDIA_KEY]?.rewrite).toBeUndefined()
  })

  it('default target http://127.0.0.1:8000; RICOTDIN_DEV_API overrides', () => {
    expect(DEFAULT_TARGET).toBe('http://127.0.0.1:8000')
    expect(proxyTarget({})).toBe('http://127.0.0.1:8000')
    expect(proxyTarget({ RICOTDIN_DEV_API: 'http://127.0.0.1:9000' })).toBe('http://127.0.0.1:9000')
  })
})

describe('stripPrefix', () => {
  it('removes /__dev_api and keeps the rest; empty rest becomes /', () => {
    expect(DEV_API_PREFIX).toBe('/__dev_api')
    expect(stripPrefix('/__dev_api/auth/me')).toBe('/auth/me')
    expect(stripPrefix('/__dev_api?x=1')).toBe('/?x=1')
    expect(stripPrefix('/__dev_api')).toBe('/')
    expect(stripPrefix('/media?t=1')).toBe('/media?t=1')
  })
})

describe('devConfig', () => {
  it('points apiUrl and authUrl at the dev server origin and names the prefix', () => {
    expect(devConfig('localhost:5173')).toEqual({
      apiUrl: 'http://localhost:5173',
      authUrl: 'http://localhost:5173',
      devProxy: '/__dev_api',
    })
    expect(devConfig('127.0.0.1:5173')?.apiUrl).toBe('http://127.0.0.1:5173')
    expect(devConfig('localhost')?.apiUrl).toBe('http://localhost')
  })

  it('refuses any other host (no config for a non-loopback Host header)', () => {
    for (const host of [undefined, '', 'evil.test', 'evil.test:5173', 'localhost.evil.test', '192.168.1.5:5173', 'localhost:99999x', '[::1]:5173', 'user@localhost:5173']) {
      expect(devConfig(host), String(host)).toBeNull()
    }
  })
})

describe('tokenFilePath', () => {
  it('default under the home dir (outside the repo); RICOTDIN_DEV_TOKEN_FILE overrides', () => {
    expect(tokenFilePath({}, '/home/ming')).toBe(path.join('/home/ming', '.config', 'ricotdin', 'dev-token'))
    expect(tokenFilePath({ RICOTDIN_DEV_TOKEN_FILE: '/x/t' }, '/home/ming')).toBe('/x/t')
  })
})

describe('readDevToken', () => {
  it('missing file -> missing', () => {
    expect(readDevToken(tokenFile(null), NOW)).toEqual({ status: 'missing' })
  })
  it('not JWT-shaped -> malformed', () => {
    expect(readDevToken(tokenFile('not a token'), NOW)).toEqual({ status: 'malformed' })
    expect(readDevToken(tokenFile('a.b.c'), NOW)).toEqual({ status: 'malformed' })
    expect(readDevToken(tokenFile(''), NOW)).toEqual({ status: 'malformed' })
  })
  it('exp in the past -> expired', () => {
    expect(readDevToken(tokenFile(STALE), NOW)).toEqual({ status: 'expired' })
  })
  it('valid -> token (trailing newline trimmed)', () => {
    expect(readDevToken(tokenFile(FRESH + '\n'), NOW)).toEqual({ status: 'ok', token: FRESH })
  })
})

describe('rewriteAuth', () => {
  const ok = { status: 'ok', token: FRESH } as const

  it('always strips the client Authorization header', () => {
    const out = rewriteAuth({ authorization: 'Bearer attacker', accept: 'x' }, ok)
    expect(out.authorization).toBe(`Bearer ${FRESH}`)
    expect(out.accept).toBe('x')
    expect(rewriteAuth({ authorization: 'Bearer attacker' }, { status: 'expired' })).toEqual({})
  })

  it('adds the bearer for sec-fetch-site same-origin or absent; not cross-site, same-site, none', () => {
    expect(rewriteAuth({}, ok).authorization).toBe(`Bearer ${FRESH}`)
    expect(rewriteAuth({ 'sec-fetch-site': 'same-origin' }, ok).authorization).toBe(`Bearer ${FRESH}`)
    for (const site of ['cross-site', 'same-site', 'none']) {
      expect(rewriteAuth({ 'sec-fetch-site': site }, ok).authorization).toBeUndefined()
    }
  })

  it('no header when the token is missing, expired or malformed', () => {
    for (const status of ['missing', 'expired', 'malformed'] as const) {
      expect(rewriteAuth({}, { status }).authorization).toBeUndefined()
    }
  })
})

describe('warnings', () => {
  it('never contain the token', () => {
    expect(warningFor({ status: 'ok', token: FRESH })).toBeNull()
    for (const status of ['missing', 'expired', 'malformed'] as const) {
      const w = warningFor({ status })
      expect(w).toBe(`[dev-token] token ${status} - run scripts/dev-token.sh`)
    }
  })

  it('plugin logs one line per distinct problem and never the token', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const file = tokenFile(null)
    vi.stubEnv('RICOTDIN_DEV_TOKEN_FILE', file)
    const proxy = proxyOf(devTokenProxy())
    let handler: (pr: unknown, req: unknown) => void = () => {}
    proxy[PROXY_KEY]?.configure({ on: (_e, cb) => (handler = cb as typeof handler) })
    const headers: Record<string, string> = {}
    const proxyReq = {
      removeHeader: (n: string) => delete headers[n],
      setHeader: (n: string, v: string) => (headers[n] = v),
    }
    handler(proxyReq, { headers: { authorization: 'Bearer attacker' } })
    handler(proxyReq, { headers: {} })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(headers.authorization).toBeUndefined()
    fs.writeFileSync(file, FRESH)
    handler(proxyReq, { headers: {} })
    expect(headers.authorization).toBe(`Bearer ${FRESH}`)
    expect(warn.mock.calls.flat().join(' ')).not.toContain(FRESH)
  })
})

describe('source scan', () => {
  const root = path.resolve(__dirname, '..')
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name)
      return e.isDirectory() ? walk(p) : [p]
    })

  it('no VITE_ in dev/; nothing under src/ or index.html mentions dev-token, devTokenProxy or RICOTDIN_DEV', () => {
    for (const f of walk(__dirname).filter((f) => !f.endsWith('.test.ts'))) {
      expect(fs.readFileSync(f, 'utf8'), f).not.toContain('VITE' + '_')
    }
    const re = /dev-token|devTokenProxy|RICOTDIN_DEV/
    for (const f of [...walk(path.join(root, 'src')), path.join(root, 'index.html')]) {
      expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(re)
    }
  })
})

describe('dev server guards', () => {
  it('rejects a non-loopback RICOTDIN_DEV_API', () => {
    expect(() => proxyTarget({ RICOTDIN_DEV_API: 'http://example.com' })).toThrow()
    expect(() => proxyTarget({ RICOTDIN_DEV_API: 'https://ricotdin-api.mmlabs.online' })).toThrow()
    expect(() => proxyTarget({ RICOTDIN_DEV_API: 'nonsense' })).toThrow()
    expect(proxyTarget({ RICOTDIN_DEV_API: 'http://localhost:9000' })).toBe('http://localhost:9000')
    expect(proxyTarget({ RICOTDIN_DEV_API: 'http://[::1]:9000' })).toBe('http://[::1]:9000')
  })

  it('allows only a loopback server host', () => {
    for (const host of [undefined, '127.0.0.1', 'localhost', '::1']) {
      expect(() => assertLocalServer({ host })).not.toThrow()
    }
    for (const host of [true, '0.0.0.0', '192.168.1.5', '']) {
      expect(() => assertLocalServer({ host })).toThrow()
    }
  })

  it('refuses allowedHosts: true', () => {
    expect(() => assertLocalServer({ host: '127.0.0.1', allowedHosts: true })).toThrow()
    expect(() => assertLocalServer({ host: '127.0.0.1', allowedHosts: ['a.test'] })).not.toThrow()
  })
})
