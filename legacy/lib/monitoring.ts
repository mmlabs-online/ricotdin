// Thin Sentry wrapper — the ONLY place that references @sentry/nextjs.
//
// Behaviour:
//   - SENTRY_DSN unset  → immediate no-op, zero overhead.
//   - SENTRY_DSN set    → captures server-side exceptions with safe context.
//
// Privacy rule: `ctx` accepts only identifiers and counts — never transcript text,
// audio, API keys, or request bodies. Enforced by the typed parameter.
//
// To enable Sentry: set SENTRY_DSN in .env.local. The SDK is already installed
// (@sentry/nextjs) and initialised in instrumentation.ts on server start.

import * as Sentry from '@sentry/nextjs'

export interface MonitoringCtx {
  jobId?: string
  meetingId?: string
  userId?: string
  step?: string
  attempt?: number
  provider?: string
}

/**
 * Capture a server-side exception in Sentry. No-op when SENTRY_DSN is unset.
 * Never throws — a monitoring failure must never surface to users.
 */
export function captureException(err: unknown, ctx?: MonitoringCtx): void {
  if (!process.env.SENTRY_DSN) return
  try {
    Sentry.withScope((scope) => {
      if (ctx) scope.setExtras(ctx as Record<string, unknown>)
      Sentry.captureException(err)
    })
  } catch {
    // noop — monitoring must never break the caller
  }
}
