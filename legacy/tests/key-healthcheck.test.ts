// Unit tests for API key health-check pure logic — all pure, no I/O.
// Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getProbeConfig,
  classifyProbeResult,
  classifyProbeError,
  isHealthCheckDue,
  summarizeHealth,
  HEALTH_CHECK_INTERVAL_MS,
} from '../lib/keys/healthcheck.js'

// ── getProbeConfig ──────────────────────────────────────────────────────────

describe('getProbeConfig', () => {
  it('returns a config for each supported provider config_key', () => {
    for (const key of ['gemini_api_key', 'openai_api_key', 'grok_api_key', 'speechmatics_api_key']) {
      const cfg = getProbeConfig(key)
      assert.ok(cfg, `expected a probe config for ${key}`)
    }
  })

  it('returns null for an unknown config_key', () => {
    assert.equal(getProbeConfig('unknown_api_key'), null)
    assert.equal(getProbeConfig(''), null)
  })

  it('embeds the key in the query for gemini (query auth mode) and never in the header', () => {
    const cfg = getProbeConfig('gemini_api_key')!
    assert.equal(cfg.authMode, 'query')
    const url = cfg.url('SECRET123')
    assert.ok(url.includes('key=SECRET123'), 'gemini probe URL should carry the key as a query param')
  })

  it('uses bearer auth (key NOT in URL) for openai / grok / speechmatics', () => {
    for (const key of ['openai_api_key', 'grok_api_key', 'speechmatics_api_key']) {
      const cfg = getProbeConfig(key)!
      assert.equal(cfg.authMode, 'bearer')
      assert.ok(!cfg.url('SECRET123').includes('SECRET123'), `${key} must not put the key in the URL`)
    }
  })

  it('probes gemini/openai/speechmatics with a GET and no body', () => {
    for (const key of ['gemini_api_key', 'openai_api_key', 'speechmatics_api_key']) {
      const cfg = getProbeConfig(key)!
      assert.notEqual(cfg.method, 'POST')
      assert.equal(cfg.body, undefined)
    }
  })

  it('probes grok with a minimal chat-completion POST (xAI keys cannot list models by default)', () => {
    const cfg = getProbeConfig('grok_api_key')!
    assert.equal(cfg.method, 'POST')
    assert.ok(cfg.url('x').endsWith('/chat/completions'), 'grok probe must hit chat/completions, not /models')
    assert.ok(cfg.body, 'grok probe must send a JSON body')
    assert.equal(cfg.body!.max_tokens, 1, 'grok probe must cap output at 1 token')
    assert.ok(typeof cfg.body!.model === 'string' && (cfg.body!.model as string).length > 0)
    assert.ok(Array.isArray(cfg.body!.messages), 'grok probe body needs a messages array')
  })
})

// ── classifyProbeResult ─────────────────────────────────────────────────────

describe('classifyProbeResult', () => {
  it('treats 2xx as healthy', () => {
    assert.equal(classifyProbeResult(200).status, 'healthy')
    assert.equal(classifyProbeResult(204).status, 'healthy')
  })

  it('treats 429 as healthy — rate limit is applied after auth, so the key is valid', () => {
    assert.equal(classifyProbeResult(429).status, 'healthy')
  })

  it('treats 401 and 403 as unhealthy', () => {
    assert.equal(classifyProbeResult(401).status, 'unhealthy')
    assert.equal(classifyProbeResult(403).status, 'unhealthy')
  })

  it('treats 5xx as unknown (provider fault, not the key)', () => {
    assert.equal(classifyProbeResult(500).status, 'unknown')
    assert.equal(classifyProbeResult(503).status, 'unknown')
  })

  it('treats 400 / other as unknown (inconclusive)', () => {
    assert.equal(classifyProbeResult(400).status, 'unknown')
    assert.equal(classifyProbeResult(418).status, 'unknown')
  })

  it('always returns a non-empty detail string', () => {
    for (const s of [200, 401, 403, 429, 500, 400]) {
      assert.ok(classifyProbeResult(s).detail.length > 0)
    }
  })
})

// ── classifyProbeError ──────────────────────────────────────────────────────

describe('classifyProbeError', () => {
  it('maps a thrown error to unknown (unreachable ≠ bad key)', () => {
    const v = classifyProbeError(new Error('ECONNRESET'))
    assert.equal(v.status, 'unknown')
    assert.ok(v.detail.includes('ECONNRESET'))
  })

  it('handles non-Error throwables', () => {
    assert.equal(classifyProbeError('boom').status, 'unknown')
  })
})

// ── isHealthCheckDue ────────────────────────────────────────────────────────

describe('isHealthCheckDue', () => {
  const now = 1_000_000_000_000

  it('is due when there has never been a run', () => {
    assert.equal(isHealthCheckDue(null, now), true)
  })

  it('is due when the last run is older than the interval', () => {
    const lastRun = new Date(now - HEALTH_CHECK_INTERVAL_MS - 1000).toISOString()
    assert.equal(isHealthCheckDue(lastRun, now), true)
  })

  it('is NOT due when the last run is within the interval', () => {
    const lastRun = new Date(now - 60_000).toISOString()
    assert.equal(isHealthCheckDue(lastRun, now), false)
  })

  it('is due exactly at the interval boundary', () => {
    const lastRun = new Date(now - HEALTH_CHECK_INTERVAL_MS).toISOString()
    assert.equal(isHealthCheckDue(lastRun, now), true)
  })

  it('is due when the stored timestamp is unparseable', () => {
    assert.equal(isHealthCheckDue('not-a-date', now), true)
  })

  it('respects a custom interval', () => {
    const lastRun = new Date(now - 5000).toISOString()
    assert.equal(isHealthCheckDue(lastRun, now, 10_000), false)
    assert.equal(isHealthCheckDue(lastRun, now, 1000), true)
  })
})

// ── summarizeHealth ─────────────────────────────────────────────────────────

describe('summarizeHealth', () => {
  it('counts verdicts by status', () => {
    const s = summarizeHealth([
      { status: 'healthy' },
      { status: 'healthy' },
      { status: 'unhealthy' },
      { status: 'unknown' },
    ])
    assert.deepEqual(s, { total: 4, healthy: 2, unhealthy: 1, unknown: 1 })
  })

  it('handles an empty batch', () => {
    assert.deepEqual(summarizeHealth([]), { total: 0, healthy: 0, unhealthy: 0, unknown: 0 })
  })
})
