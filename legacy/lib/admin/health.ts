// Pure helpers for the admin health-check endpoint.
// No I/O — fully unit-testable in isolation.

export interface CheckResult {
  status: 'ok' | 'error'
  message?: string
}

export interface HealthReport {
  status: 'ok' | 'degraded'
  ts: string
  checks: Record<string, CheckResult>
}

export function buildHealthReport(
  checks: Record<string, CheckResult>,
  ts?: string,
): HealthReport {
  const anyError = Object.values(checks).some((c) => c.status === 'error')
  return {
    status: anyError ? 'degraded' : 'ok',
    ts: ts ?? new Date().toISOString(),
    checks,
  }
}

export function formatUptimeSecs(seconds: number): string {
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60

  if (h > 0) {
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }
  if (m > 0) {
    return sec > 0 ? `${m}m ${sec}s` : `${m}m`
  }
  return `${sec}s`
}
