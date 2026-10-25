// Next.js instrumentation — runs ONCE on server startup.
//
// This file is bundled for BOTH the Node.js and Edge runtimes, so it must not
// statically import any `node:*` modules (the Edge analyzer rejects them). The
// actual TLS setup lives in `instrumentation-node.ts` and is loaded lazily, and
// only on the Node.js runtime, via a dynamic import.
//
// See `instrumentation-node.ts` for why this exists (corporate TLS proxy).

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // 1. Corporate TLS proxy setup must run first so that all outbound HTTPS
    //    calls (Speechmatics, Gemini, Supabase) trust the corporate CA.
    await import('./instrumentation-node')

    // 2. Init Sentry error tracking (OBS-01).
    //    No-op when SENTRY_DSN is unset (local dev / deployments without Sentry).
    //    beforeSend strips request.data to prevent accidental transcript capture.
    if (process.env.SENTRY_DSN) {
      const { init, browserTracingIntegration } = await import('@sentry/nextjs')
      void browserTracingIntegration  // import unused — silence tree-shaker warning
      init({
        dsn: process.env.SENTRY_DSN,
        tracesSampleRate: 0,          // error capture only — no performance tracing
        beforeSend(event) {
          // Strip request body: prevents transcript text / audio metadata from
          // appearing in Sentry payloads (NFR-2 privacy constraint).
          if (event.request) {
            delete event.request.data
          }
          return event
        },
      })
    }

    // 3. Start the durable job worker after TLS + monitoring are ready.
    const { startWorker } = await import('./lib/jobs/startup')
    startWorker()

    // 4. Start the daily API key health-check scheduler.
    const { startHealthCheckScheduler } = await import('./lib/keys/healthScheduler')
    startHealthCheckScheduler()

    // 5. Start the daily audio retention purge (PRV-02). No-op until
    //    storage.audio_retention_days is set in /admin/config.
    const { startRetentionPurgeScheduler } = await import('./lib/retention/purgeScheduler')
    startRetentionPurgeScheduler()
  }
}
