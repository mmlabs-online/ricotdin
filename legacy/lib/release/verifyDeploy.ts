// Pure logic for `npm run verify:deploy` (OPS-07): turns the HTTP results of
// GET /version.json and GET /api/health into PASS/FAIL checks.
// No I/O here — scripts/verify-deploy.ts does the fetching and printing.

export type HttpResult = { status: number; body: unknown } | { error: string }

export interface DeployCheck {
  name: 'version' | 'health'
  ok: boolean
  skipped?: boolean
  detail: string
}

export class VerifyArgsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VerifyArgsError'
  }
}

// A commit SHA or 'unknown' means RICOTDIN_VERSION was not set on the container
// (see resolveAppVersion in lib/release/version.ts).
const UNSET_VERSION = /^(unknown|[0-9a-f]{7,40})$/

function fieldOf(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined
}

function checkVersion(result: HttpResult, expected: string | undefined): DeployCheck {
  if ('error' in result) return { name: 'version', ok: false, detail: `request failed: ${result.error}` }
  if (result.status !== 200) return { name: 'version', ok: false, detail: `HTTP ${result.status}` }
  const actual = fieldOf(result.body, 'version')
  if (typeof actual !== 'string' || !actual) {
    return { name: 'version', ok: false, detail: 'response has no "version" field' }
  }
  if (!expected) return { name: 'version', ok: true, skipped: true, detail: `running ${actual} (no --expect)` }
  if (actual === expected) return { name: 'version', ok: true, detail: `running ${actual}` }
  const hint = UNSET_VERSION.test(actual)
    ? ' — set RICOTDIN_VERSION on the container (e.g. docker run -e RICOTDIN_VERSION=' + expected + ')'
    : ''
  return { name: 'version', ok: false, detail: `expected ${expected}, running ${actual}${hint}` }
}

function checkHealth(result: HttpResult): DeployCheck {
  if ('error' in result) return { name: 'health', ok: false, detail: `request failed: ${result.error}` }
  if (result.status !== 200) return { name: 'health', ok: false, detail: `HTTP ${result.status}` }
  if (fieldOf(result.body, 'status') !== 'ok') {
    return { name: 'health', ok: false, detail: 'body is not {"status":"ok"}' }
  }
  return { name: 'health', ok: true, detail: 'HTTP 200 {"status":"ok"}' }
}

export function evaluateDeploy(input: {
  expected?: string
  version: HttpResult
  health: HttpResult
}): { checks: DeployCheck[]; ok: boolean } {
  const checks = [checkVersion(input.version, input.expected), checkHealth(input.health)]
  return { checks, ok: checks.every((c) => c.ok) }
}

export function parseVerifyArgs(argv: string[]): { url: string; expected?: string } {
  let expected: string | undefined
  const positional: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--expect') {
      const next = argv[i + 1]
      if (!next || next.startsWith('-')) throw new VerifyArgsError('--expect needs a version, e.g. --expect v1.1.0')
      expected = next
      i++
    } else if (arg.startsWith('--expect=')) {
      expected = arg.slice('--expect='.length)
      if (!expected) throw new VerifyArgsError('--expect needs a version, e.g. --expect v1.1.0')
    } else if (arg.startsWith('-')) {
      // A mistyped flag must not silently drop the version check.
      throw new VerifyArgsError(`unknown option ${arg} (only --expect is supported)`)
    } else {
      positional.push(arg)
    }
  }

  const usage = 'usage: npm run verify:deploy -- <https://host> [--expect vX.Y.Z]'
  if (positional.length === 0) throw new VerifyArgsError(usage)
  if (positional.length > 1) throw new VerifyArgsError(`unexpected argument ${positional[1]} — ${usage}`)

  const raw = positional[0]
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new VerifyArgsError(`not a URL: ${raw} (include http:// or https://)`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new VerifyArgsError(`unsupported protocol ${parsed.protocol} (use http or https)`)
  }

  // Release tags are v-prefixed (CHANGELOG [1.1.0]); accept "1.1.0" too.
  if (expected && /^\d/.test(expected)) expected = `v${expected}`
  return expected ? { url: parsed.origin, expected } : { url: parsed.origin }
}

// Node's fetch reports DNS/TLS/connection failures as a bare "fetch failed" with the
// real reason in `cause` — surface it.
export function describeFetchError(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  const cause = (e as Error & { cause?: unknown }).cause
  if (typeof cause === 'object' && cause !== null) {
    const { code, message } = cause as { code?: unknown; message?: unknown }
    const reason = typeof code === 'string' ? code : typeof message === 'string' ? message : undefined
    if (reason) return `${e.message} (${reason})`
  }
  return e.message
}
