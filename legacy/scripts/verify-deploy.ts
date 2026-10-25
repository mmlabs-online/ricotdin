// Post-deploy check (OPS-07): is the expected release running and healthy?
// Read-only: two public GETs, no secrets. Logic lives in lib/release/verifyDeploy.ts.
//
// Usage:
//   npm run verify:deploy -- https://<host> --expect v1.1.0
//   npm run verify:deploy -- http://localhost:3000            # just print the version + health
//
// Exit code 0 when every check passes, 1 otherwise (2 on bad arguments).

import {
  describeFetchError,
  evaluateDeploy,
  parseVerifyArgs,
  VerifyArgsError,
  type HttpResult,
} from '../lib/release/verifyDeploy.js'

const TIMEOUT_MS = 10_000

async function get(url: string): Promise<HttpResult> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' })
    const text = await res.text()
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {
      // Non-JSON body: keep the raw text; the evaluator reports it as a wrong body.
    }
    return { status: res.status, body }
  } catch (e) {
    return { error: describeFetchError(e) }
  }
}

async function main() {
  let args: { url: string; expected?: string }
  try {
    args = parseVerifyArgs(process.argv.slice(2))
  } catch (e) {
    if (e instanceof VerifyArgsError) {
      console.error(e.message)
      process.exit(2)
    }
    throw e
  }

  const [version, health] = await Promise.all([
    get(`${args.url}/version.json`),
    get(`${args.url}/api/health`),
  ])
  const result = evaluateDeploy({ expected: args.expected, version, health })

  console.log(`verify:deploy ${args.url}${args.expected ? ` (expect ${args.expected})` : ''}`)
  for (const c of result.checks) {
    const label = c.skipped ? 'INFO' : c.ok ? 'PASS' : 'FAIL'
    console.log(`  ${label}  ${c.name.padEnd(8)} ${c.detail}`)
  }
  console.log(result.ok ? 'All checks passed.' : 'Some checks FAILED.')
  process.exit(result.ok ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
