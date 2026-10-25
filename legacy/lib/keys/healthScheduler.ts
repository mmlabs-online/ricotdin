// SERVER ONLY — in-process daily scheduler for the API key health check.
//
// The app runs as a long-lived `next start` process (not serverless), so a
// setInterval-based scheduler is sufficient and needs no external cron.
//
// Behavior:
//   - Started once per process from instrumentation.ts (guarded).
//   - On startup, runs immediately only if the last recorded run is stale
//     (> 24h ago or never) — so frequent restarts don't re-probe every boot.
//   - Then runs every HEALTH_CHECK_INTERVAL_MS (24h).
//
// A failed run is logged and swallowed; the next tick will retry.

import { logger } from '@/lib/logger'
import { HEALTH_CHECK_INTERVAL_MS, isHealthCheckDue } from './healthcheck'

let started = false

async function runOnce(): Promise<void> {
  try {
    const { runHealthCheck } = await import('./healthcheck-runner')
    const { summary } = await runHealthCheck()
    logger.info('[keys/healthScheduler] automated health check ran', {
      detail: `${summary.healthy} healthy / ${summary.unhealthy} unhealthy / ${summary.unknown} unknown`,
    })
  } catch (err) {
    logger.error('[keys/healthScheduler] automated health check failed', {
      detail: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startHealthCheckScheduler(): void {
  if (started) return
  started = true

  void (async () => {
    try {
      const { getLastHealthCheckAt } = await import('./healthcheck-runner')
      const lastRun = await getLastHealthCheckAt()
      if (isHealthCheckDue(lastRun, Date.now())) {
        await runOnce()
      } else {
        logger.info('[keys/healthScheduler] skipping startup run — last check is recent', {
          detail: String(lastRun),
        })
      }
    } catch (err) {
      logger.error('[keys/healthScheduler] startup check failed', {
        detail: err instanceof Error ? err.message : String(err),
      })
    }

    // Recurring daily run. unref() so the timer never keeps the process alive.
    const timer = setInterval(() => void runOnce(), HEALTH_CHECK_INTERVAL_MS)
    if (typeof timer.unref === 'function') timer.unref()
  })()

  logger.info('[keys/healthScheduler] daily API key health check scheduled')
}
