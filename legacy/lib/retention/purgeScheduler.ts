// SERVER ONLY — in-process daily scheduler for the audio retention purge (PRV-02).
//
// Same shape as lib/keys/healthScheduler.ts: the app is a single long-lived `next start`
// process, so setInterval is enough (no external cron). The purge is idempotent, so it simply
// runs once shortly after startup and then every 24h. Timers are unref()ed.
// A failed run is logged and swallowed; the next tick retries.

import { logger } from '@/lib/logger'
import { PURGE_INTERVAL_MS, PURGE_BATCH_LIMIT } from './policy'

/** Let the job worker and DB connections settle before the first run. */
const STARTUP_DELAY_MS = 60_000

let started = false
let running = false

async function runOnce(): Promise<void> {
  if (running) return
  running = true
  try {
    const { runRetentionPurge } = await import('./purge-runner')
    const s = await runRetentionPurge()
    if (s.retentionDays === null) {
      if (s.invalidSetting) {
        logger.warn('[retention] storage.audio_retention_days is not a whole number of days (1–3650) — purge is OFF')
      } else {
        logger.info('[retention] purge skipped — storage.audio_retention_days is not set')
      }
      return
    }
    logger.info('[retention] purge ran', {
      count: s.purged,
      detail: `retention=${s.retentionDays}d candidates=${s.candidates} purged=${s.purged} skipped=${s.skipped} failed=${s.failed}`,
    })
    // Failed rows stay oldest-first in the queue; a full batch of failures blocks newer rows.
    if (s.failed > 0 && s.failed === s.candidates && s.candidates === PURGE_BATCH_LIMIT) {
      logger.error('[retention] every candidate in a full batch failed — newer audio is not being purged; check storage config')
    }
  } catch (err) {
    logger.error('[retention] purge failed', { detail: err instanceof Error ? err.message : String(err) })
  } finally {
    running = false
  }
}

export function startRetentionPurgeScheduler(): void {
  if (started) return
  started = true

  const first = setTimeout(() => void runOnce(), STARTUP_DELAY_MS)
  if (typeof first.unref === 'function') first.unref()

  const timer = setInterval(() => void runOnce(), PURGE_INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()

  logger.info('[retention] daily audio retention purge scheduled')
}
