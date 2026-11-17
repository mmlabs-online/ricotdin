// @vitest-environment node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const file = path.resolve(__dirname, 'dev-token.sh')
const src = fs.readFileSync(file, 'utf8')
const lines = src.split('\n').filter((l) => !l.trimStart().startsWith('#'))

describe('scripts/dev-token.sh (static invariants)', () => {
  it('is valid bash with LF line endings', () => {
    expect(src).not.toContain('\r')
    const r = spawnSync('bash', ['-n', file], { encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  it('reads the password with read -s, uses umask 077, sends the production Origin and X-MM-App ricotdin', () => {
    expect(src).toMatch(/read -rs pw/)
    expect(src).toMatch(/^umask 077$/m)
    expect(src).toContain('-H "X-MM-App: $APP"')
    expect(src).toContain('-H "Origin: $ORIGIN"')
    expect(src).toContain('ORIGIN="https://ricotdin.mmlabs.online"')
    expect(src).toContain('APP="ricotdin"')
    expect(src).toContain('${RICOTDIN_DEV_EMAIL:-}')
  })

  it('passes the password only through printf into a pipe (never in a curl/node argument)', () => {
    const withPw = lines.filter((l) => l.includes('$pw'))
    expect(withPw.map((l) => l.trim())).toEqual([String.raw`status="$(printf '%s\n%s' "$email" "$pw" |`])
    expect(lines.some((l) => /echo[^\n]*\$pw/.test(l))).toBe(false)
    for (const l of lines.filter((l) => /\bcurl\b|\bnode\b/.test(l))) {
      expect(l).not.toContain('$pw')
    }
    expect(src).toMatch(/^unset pw$/m)
  })

  it('never prints the token and writes it only to the token file', () => {
    for (const l of lines.filter((l) => /\$\{?(token|out)\b/.test(l))) {
      expect(l).not.toMatch(/\becho\b/)
      expect(l).toMatch(/>"\$FILE\.tmp"|^\s*token=|^\s*expires_in=/)
    }
    expect(src).toContain('mv "$FILE.tmp" "$FILE"')
  })

  it('keeps the token file outside the repo by default; RICOTDIN_DEV_TOKEN_FILE overrides', () => {
    expect(src).toContain('FILE="${RICOTDIN_DEV_TOKEN_FILE:-$HOME/.config/ricotdin/dev-token}"')
  })
})
