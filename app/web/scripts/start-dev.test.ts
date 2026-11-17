// @vitest-environment node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const file = path.resolve(__dirname, 'start-dev.sh')
const src = fs.readFileSync(file, 'utf8')
const code = src
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('#'))
  .join('\n')

describe('scripts/start-dev.sh (static invariants)', () => {
  it('is valid bash with LF line endings and no xtrace', () => {
    expect(src).not.toContain('\r')
    const r = spawnSync('bash', ['-n', file], { encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(src).toMatch(/^set -eu\n\{ set \+x; \} 2>\/dev\/null$/m)
  })

  it('never runs the worker, migrations, tests or role scripts against production', () => {
    for (const bad of ['alembic', 'pytest', 'provision_db_roles', 'gen_baseline', 'connect_gdrive', 'app.worker', '-m app.']) {
      expect(code).not.toContain(bad)
    }
  })

  it('signs in first, then the tunnel, then asks for the passwords (same order as tudocuatui)', () => {
    const token = code.indexOf('scripts/dev-token.sh" || fail')
    const tunnel = code.indexOf('docker start')
    const ask = code.indexOf('ask "Password ricotdin_api_login"')
    expect(token).toBeGreaterThan(0)
    expect(tunnel).toBeGreaterThan(token)
    expect(ask).toBeGreaterThan(tunnel)
  })

  it('reads secrets only from the terminal, silently, and never from or into a file', () => {
    expect(code).toContain('IFS= read -rsp "$1: " "$2" </dev/tty')
    expect(code).not.toMatch(/--env-file "?\$/)
    expect(code.match(/--env-file/g)).toEqual(['--env-file'])
    expect(code).toContain('uv run --env-file .env.local uvicorn')
    expect(code).not.toMatch(/(^|\s)(source|\.)\s+\S/m)
    expect(code).not.toMatch(/prod-tunnel\.env|prod-key\.env|db-logins\.env"/)
    // The key is asked for only with --with-key.
    expect(code).toContain('[ "$with_key" = 1 ] && ask "KEY_ENCRYPTION_SECRET')
  })

  it('builds only the three runtime logins, through the tunnel, with a URL-encoded password', () => {
    expect(code).toContain('DB_HOST="127.0.0.1:15432"')
    expect(code).toContain("printf 'postgresql://%s:%s@%s/ricotdin?sslmode=disable' \"$1\" \"$enc\" \"$DB_HOST\"")
    expect(code).toContain('encodeURIComponent')
    const logins = [...code.matchAll(/login_url (\w+) "\$pw"/g)].map((m) => m[1])
    expect(logins).toEqual(['ricotdin_api_login', 'ricotdin_service_login', 'ricotdin_worker_login'])
    expect(code).not.toMatch(/export DATABASE_URL=|postgresql:\/\/ricotdin:/)
  })

  it('drops inherited secrets and UV_ENV_FILE, exports the typed values only to the API, then forgets them', () => {
    expect(code).toMatch(
      /start_api\(\) \{\n\s*unset DATABASE_URL DATABASE_URL_APP DATABASE_URL_SERVICE DATABASE_URL_WORKER KEY_ENCRYPTION_SECRET UV_ENV_FILE\n\s*export DATABASE_URL_APP=/,
    )
    expect(code).toMatch(/api_pid=\$!\nunset url_app url_service url_worker key\n/)
    // Only start_api exports secrets; the npm process never sees them.
    expect(code.match(/export /g)).toHaveLength(2)
  })

  it('stops the API process tree on exit, not only uv', () => {
    expect(code).toMatch(/pkill -TERM -P "\$api_pid"/)
  })

  it('binds the API to loopback and starts the SPA in dev token mode', () => {
    expect(code).toContain('--host 127.0.0.1')
    expect(code).toContain('RICOTDIN_DEV_TOKEN=1 npm run dev')
    expect(code).not.toMatch(/--host 0\.0\.0\.0|--reload/)
  })
})

describe('scripts/start-dev.sh (stops before touching anything)', () => {
  let dir: string
  let bin: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-dev-'))
    // PATH with only the text tools (no docker/uv/npm/node/curl): the script must stop at its checks
    // instead of starting the sign-in, the tunnel or the API.
    bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    for (const tool of ['dirname', 'grep', 'sed']) {
      const found = ['/usr/bin', '/bin'].map((d) => path.join(d, tool)).find((p) => fs.existsSync(p))
      if (found) fs.symlinkSync(found, path.join(bin, tool))
    }
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const run = (args: string[] = []) =>
    spawnSync(fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash', [file, ...args], {
      encoding: 'utf8',
      timeout: 10_000,
      input: '',
      env: { PATH: bin, HOME: dir },
    })

  it('rejects an unknown argument', () => {
    const r = run(['--host'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('unknown argument')
  })

  it.skipIf(process.platform === 'win32')('stops at the checks without a prompt when a tool or .env.local is missing', () => {
    const r = run(['--with-key'])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/\.env\.local not found|docker not found/)
    expect(r.stdout).not.toContain('Step 1/4')
  })
})
