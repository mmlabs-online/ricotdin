// Unit tests for the post-deploy verifier (OPS-07).
//
// All tests are pure: they exercise lib/release/verifyDeploy.ts with plain objects
// standing in for the HTTP results of /version.json and /api/health.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateDeploy,
  parseVerifyArgs,
  describeFetchError,
  VerifyArgsError,
} from '../lib/release/verifyDeploy.js'

const healthy = { status: 200, body: { status: 'ok' } }
const version = (v: unknown) => ({ status: 200, body: { version: v } })

function check(result: ReturnType<typeof evaluateDeploy>, name: string) {
  const c = result.checks.find((x) => x.name === name)
  assert.ok(c, `missing check ${name}`)
  return c
}

// ── evaluateDeploy ────────────────────────────────────────────────────────────

describe('evaluateDeploy', () => {
  it('passes when version matches and health is ok', () => {
    const r = evaluateDeploy({ expected: 'v1.1.0', version: version('v1.1.0'), health: healthy })
    assert.equal(r.ok, true)
    assert.equal(check(r, 'version').ok, true)
    assert.equal(check(r, 'health').ok, true)
  })

  it('fails on a different version', () => {
    const r = evaluateDeploy({ expected: 'v1.1.0', version: version('v1.0.0'), health: healthy })
    assert.equal(r.ok, false)
    assert.equal(check(r, 'version').ok, false)
    assert.match(check(r, 'version').detail, /v1\.0\.0/)
    assert.doesNotMatch(check(r, 'version').detail, /RICOTDIN_VERSION/)
  })

  it('hints RICOTDIN_VERSION when the version is a commit SHA or unknown', () => {
    for (const v of ['3f9c2ab', 'b7e4204d1c0e9f7a6b5c4d3e2f1a0b9c8d7e6f5a', 'unknown']) {
      const r = evaluateDeploy({ expected: 'v1.1.0', version: version(v), health: healthy })
      assert.equal(check(r, 'version').ok, false)
      assert.match(check(r, 'version').detail, /RICOTDIN_VERSION/)
    }
  })

  it('skips the version comparison without --expect but still reports the version', () => {
    const r = evaluateDeploy({ version: version('v1.1.0'), health: healthy })
    assert.equal(r.ok, true)
    const v = check(r, 'version')
    assert.equal(v.ok, true)
    assert.equal(v.skipped, true)
    assert.match(v.detail, /v1\.1\.0/)
  })

  it('fails health on non-200, wrong body, or network error', () => {
    const cases = [
      { status: 503, body: { status: 'ok' } },
      { status: 200, body: { status: 'degraded' } },
      { status: 200, body: 'not json' },
      { error: 'ECONNREFUSED' },
    ]
    for (const health of cases) {
      const r = evaluateDeploy({ expected: 'v1.1.0', version: version('v1.1.0'), health })
      assert.equal(r.ok, false)
      assert.equal(check(r, 'health').ok, false)
    }
    const r = evaluateDeploy({ version: version('v1.1.0'), health: { error: 'ECONNREFUSED' } })
    assert.match(check(r, 'health').detail, /ECONNREFUSED/)
  })

  it('fails version on non-200, missing field, or network error', () => {
    const cases = [
      { status: 404, body: {} },
      { status: 200, body: {} },
      { error: 'timeout' },
    ]
    for (const v of cases) {
      const r = evaluateDeploy({ expected: 'v1.1.0', version: v, health: healthy })
      assert.equal(check(r, 'version').ok, false)
    }
  })
})

// ── parseVerifyArgs ───────────────────────────────────────────────────────────

describe('parseVerifyArgs', () => {
  it('parses url and --expect', () => {
    assert.deepEqual(parseVerifyArgs(['https://ricotdin.example.com', '--expect', 'v1.1.0']), {
      url: 'https://ricotdin.example.com',
      expected: 'v1.1.0',
    })
    assert.deepEqual(parseVerifyArgs(['--expect=v1.1.0', 'http://localhost:3000']), {
      url: 'http://localhost:3000',
      expected: 'v1.1.0',
    })
  })

  it('drops a trailing slash and allows no --expect', () => {
    assert.deepEqual(parseVerifyArgs(['https://ricotdin.example.com/']), {
      url: 'https://ricotdin.example.com',
    })
  })

  it('throws VerifyArgsError on a missing or invalid url', () => {
    assert.throws(() => parseVerifyArgs([]), VerifyArgsError)
    assert.throws(() => parseVerifyArgs(['ricotdin.example.com']), VerifyArgsError)
    assert.throws(() => parseVerifyArgs(['ftp://x']), VerifyArgsError)
  })

  it('throws VerifyArgsError when --expect has no value', () => {
    assert.throws(() => parseVerifyArgs(['https://x.example', '--expect']), VerifyArgsError)
  })

  it('rejects an unknown flag instead of silently skipping the version check', () => {
    assert.throws(() => parseVerifyArgs(['https://x.example', '--expext', 'v1.1.0']), VerifyArgsError)
    assert.throws(() => parseVerifyArgs(['https://x.example', '-e', 'v1.1.0']), VerifyArgsError)
  })

  it('rejects more than one positional argument', () => {
    assert.throws(() => parseVerifyArgs(['https://x.example', 'v1.1.0']), VerifyArgsError)
  })

  it('uses only the origin of the url (path and query are dropped)', () => {
    assert.deepEqual(parseVerifyArgs(['https://x.example/foo?x=1']), { url: 'https://x.example' })
    assert.deepEqual(parseVerifyArgs(['http://localhost:3000/']), { url: 'http://localhost:3000' })
  })

  it('normalises --expect to the v-prefixed tag form', () => {
    assert.deepEqual(parseVerifyArgs(['https://x.example', '--expect', '1.1.0']), {
      url: 'https://x.example',
      expected: 'v1.1.0',
    })
  })
})

// ── describeFetchError ────────────────────────────────────────────────────────

describe('describeFetchError', () => {
  it('surfaces the cause code behind Node\'s generic "fetch failed"', () => {
    const e = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:9' } })
    assert.equal(describeFetchError(e), 'fetch failed (ECONNREFUSED)')
  })

  it('falls back to the cause message, then the error message', () => {
    assert.equal(describeFetchError(new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND x') })), 'fetch failed (getaddrinfo ENOTFOUND x)')
    assert.equal(describeFetchError(new Error('The operation was aborted due to timeout')), 'The operation was aborted due to timeout')
    assert.equal(describeFetchError('boom'), 'boom')
  })
})
