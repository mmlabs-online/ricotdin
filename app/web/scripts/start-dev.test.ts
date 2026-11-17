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

const GOOD = [
  'DATABASE_URL_APP=postgresql://ricotdin_api_login:x@127.0.0.1:15432/ricotdin?sslmode=disable',
  'DATABASE_URL_SERVICE=postgresql://ricotdin_service_login:x@127.0.0.1:15432/ricotdin?sslmode=disable',
  'DATABASE_URL_WORKER=postgresql://ricotdin_worker_login:x@127.0.0.1:15432/ricotdin?sslmode=disable',
].join('\n')

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

  it('reads the owner files only through uv --env-file (never sourced) and the key only with --with-key', () => {
    expect(code).not.toMatch(/(^|\s)(source|\.)\s+"?\$(DB_ENV|KEY_ENV)/m)
    expect(code).toContain('--env-file "$DB_ENV"')
    expect(code).toMatch(/if \[ "\$with_key" = 1 \]; then\n\s*exec uv run [^\n]*--env-file "\$KEY_ENV"/)
    expect(code.match(/--env-file "\$KEY_ENV"/g)).toHaveLength(1)
    expect(src).toContain('DB_ENV="$(abs_file "${RICOTDIN_DEV_DB_ENV:-$HOME/.config/ricotdin/prod-tunnel.env}")"')
    expect(src).toContain('KEY_ENV="$(abs_file "${RICOTDIN_DEV_KEY_ENV:-$HOME/.config/ricotdin/prod-key.env}")"')
  })

  it('drops inherited secrets and UV_ENV_FILE before starting the API (env files must win)', () => {
    expect(code).toMatch(
      /start_api\(\) \{\n\s*unset DATABASE_URL DATABASE_URL_APP DATABASE_URL_SERVICE DATABASE_URL_WORKER KEY_ENCRYPTION_SECRET UV_ENV_FILE\n/,
    )
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

describe('scripts/start-dev.sh (refuses unsafe setups before touching anything)', () => {
  let dir: string
  let bin: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-dev-'))
    // PATH with only the text tools (no docker/uv/npm/node/curl): a case that wrongly passes the file
    // checks stops at "not found" instead of starting the tunnel, the token prompt or the API.
    bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    for (const tool of ['dirname', 'stat', 'grep', 'sed']) {
      const found = ['/usr/bin', '/bin'].map((d) => path.join(d, tool)).find((p) => fs.existsSync(p))
      if (found) fs.symlinkSync(found, path.join(bin, tool))
    }
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const run = (env: Record<string, string>, args: string[] = [], cwd?: string) =>
    spawnSync(fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash', [file, ...args], {
      encoding: 'utf8',
      cwd,
      timeout: 10_000,
      input: '',
      env: { PATH: bin, HOME: dir, RICOTDIN_DEV_DB_ENV: path.join(dir, 'db.env'), ...env },
    })
  const write = (name: string, body: string, mode = 0o600) => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, body)
    fs.chmodSync(p, mode)
    return p
  }

  it('rejects an unknown argument', () => {
    const r = run({}, ['--host'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('unknown argument')
  })

  it('fails when the runtime logins file is missing', () => {
    const r = run({})
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('not found')
  })

  it.skipIf(process.platform === 'win32')('accepts valid owner files (stops only at a later step)', () => {
    const db = write('db.env', `# runtime logins\n${GOOD}`)
    const key = write('key.env', 'KEY_ENCRYPTION_SECRET=x')
    // It must get past the file checks and stop at a later step (.env.local missing, or "docker not found").
    const r = run({ RICOTDIN_DEV_KEY_ENV: key }, ['--with-key'])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/\.env\.local not found|docker not found/)
    expect(r.stderr).not.toContain(db)
    expect(r.stderr).not.toContain(key)
  })

  it.skipIf(process.platform === 'win32')('refuses a file readable by others', () => {
    write('db.env', GOOD, 0o644)
    const r = run({})
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('chmod 600')
  })

  it.skipIf(process.platform === 'win32')('refuses the owner DATABASE_URL', () => {
    write('db.env', `${GOOD}\nDATABASE_URL=postgresql://ricotdin:x@127.0.0.1:15432/ricotdin`)
    const r = run({})
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('owner')
  })

  it.skipIf(process.platform === 'win32')('refuses a login that does not go through the tunnel', () => {
    write('db.env', GOOD.replace('127.0.0.1:15432', 'postgres:5432'))
    const r = run({})
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('127.0.0.1:15432')
  })

  it.skipIf(process.platform === 'win32')('refuses a duplicate key (dotenv keeps the first one)', () => {
    write('db.env', `DATABASE_URL_APP=postgresql://a:x@db.example:5432/ricotdin\n${GOOD}`)
    const r = run({})
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('exactly one DATABASE_URL_APP')
  })

  it.skipIf(process.platform === 'win32')('refuses query parameters other than sslmode (?host= leaves the tunnel)', () => {
    write('db.env', GOOD.replace('?sslmode=disable', '?sslmode=disable&host=db.example'))
    const r = run({})
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('127.0.0.1:15432')
  })

  it.skipIf(process.platform === 'win32')('refuses export-prefixed or indented lines', () => {
    write('db.env', `${GOOD}\n  export DATABASE_URL_APP=postgresql://a:x@db.example:5432/ricotdin`)
    const r = run({})
    expect(r.status).toBe(1)
  })

  it.skipIf(process.platform === 'win32')('refuses a symlinked secrets file', () => {
    const real = write('real.env', GOOD)
    fs.symlinkSync(real, path.join(dir, 'db.env'))
    const r = run({})
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('symlink')
  })

  it.skipIf(process.platform === 'win32')('refuses a secrets file inside the repo, also through a relative path', () => {
    const inRepo = path.resolve(__dirname, '.start-dev-test.env')
    fs.writeFileSync(inRepo, GOOD)
    fs.chmodSync(inRepo, 0o600)
    try {
      const r = run({ RICOTDIN_DEV_DB_ENV: '.start-dev-test.env' }, [], __dirname)
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('inside the repo')
    } finally {
      fs.rmSync(inRepo, { force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('refuses a key file with two KEY_ENCRYPTION_SECRET lines', () => {
    write('db.env', GOOD)
    const key = write('key.env', 'KEY_ENCRYPTION_SECRET=x\nKEY_ENCRYPTION_SECRET=y')
    const r = run({ RICOTDIN_DEV_KEY_ENV: key }, ['--with-key'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('KEY_ENCRYPTION_SECRET')
  })

  it.skipIf(process.platform === 'win32')('refuses a key file holding anything but KEY_ENCRYPTION_SECRET', () => {
    write('db.env', GOOD)
    const key = write('key.env', 'KEY_ENCRYPTION_SECRET=x\nOTHER=y')
    const r = run({ RICOTDIN_DEV_KEY_ENV: key }, ['--with-key'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('KEY_ENCRYPTION_SECRET')
  })
})
