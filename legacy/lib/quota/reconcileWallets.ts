// SERVER ONLY — uses the service-role client (bypasses RLS).
//
// QUO-04 ledger↔wallet reconciliation.
//
// Recomputes each user's expected balance from the append-only quota_ledger and
// corrects any drift in quota_wallets.
//
// RECONCILE_MODE:
//   'detect_and_adjust' — write an 'adjustment' ledger entry on drift. The
//     correction is auditable; ledger remains the source of truth.
//   'detect_only'       — log/alert on drift, make no changes.
//
// Scheduled by the worker loop (lib/jobs/worker.ts) every RECONCILE_INTERVAL_MS.
// Does NOT reimplement QUO-02's orphaned-reservation sweep (reconcileStuckReservations).
// The two jobs operate at different scopes and share no dedup-key namespace.
//
// READ-SKEW NOTE: wallet and ledger are read in two separate queries. A concurrent
// applyQuotaMovement between reads can produce a false drift detection. False
// adjustments are self-correcting: the adjustment row appears in both ledger and
// wallet, so the next run sees no drift. Recurring false-positives indicate a
// genuine underlying bug and should be investigated.

import { randomUUID } from 'node:crypto'
import { log, logger } from '@/lib/logger'
import { createServerClient } from '@/lib/supabase/server'
import { applyQuotaMovement } from './applyQuotaMovement'
import { computeWalletDrift, formatReconcileKey } from './reconcileWallets.pure'

// Switch to 'detect_only' to audit without making any DB changes.
const RECONCILE_MODE: 'detect_and_adjust' | 'detect_only' = 'detect_and_adjust'

export interface ReconcileWalletsResult {
  checked: number
  drifted: number
  adjusted: number
  runId: string
}

/**
 * For every row in quota_wallets, recompute the expected balance from
 * quota_ledger and correct any drift.
 *
 * Idempotent per run: dedup key is `reconcile:{userId}:{runId}`. Starting the
 * job twice with the same runId (e.g. crash-restart within the same interval
 * window) is safe — the second call returns 'already_applied' for each user.
 */
export async function reconcileWallets(): Promise<ReconcileWalletsResult> {
  const runId = randomUUID()
  log(`[wallet-reconcile] starting run=${runId} mode=${RECONCILE_MODE}`)

  const db = createServerClient()

  const { data: wallets, error: walletErr } = await db
    .from('quota_wallets')
    .select('user_id, audio_seconds_remaining, agent_queries_remaining')

  if (walletErr) {
    logger.error('[wallet-reconcile] failed to fetch wallets', { detail: walletErr.message, runId })
    return { checked: 0, drifted: 0, adjusted: 0, runId }
  }

  const allWallets = wallets ?? []
  let drifted = 0
  let adjusted = 0

  for (const wallet of allWallets) {
    try {
      // N+1 per user — acceptable for MVP user counts. Scale note: replace with
      // a GROUP BY aggregate RPC when wallet count grows past ~1 000 users.
      const { data: rows, error: ledgerErr } = await db
        .from('quota_ledger')
        .select('delta_audio_seconds, delta_agent_queries')
        .eq('user_id', wallet.user_id)

      if (ledgerErr) {
        logger.error('[wallet-reconcile] failed to fetch ledger for user', {
          userId: wallet.user_id,
          detail: ledgerErr.message,
          runId,
        })
        continue
      }

      const ledgerRows = rows ?? []
      const ledgerAudio = ledgerRows.reduce((sum, r) => sum + Number(r.delta_audio_seconds), 0)
      const ledgerQueries = ledgerRows.reduce((sum, r) => sum + r.delta_agent_queries, 0)

      const drift = computeWalletDrift(
        Number(wallet.audio_seconds_remaining),
        wallet.agent_queries_remaining,
        ledgerAudio,
        ledgerQueries,
      )

      if (!drift.hasDrift) continue

      drifted++
      logger.warn('[wallet-reconcile] drift detected', {
        userId: wallet.user_id,
        audioDrift: drift.audioDrift,
        queryDrift: drift.queryDrift,
        walletAudio: Number(wallet.audio_seconds_remaining),
        walletQueries: wallet.agent_queries_remaining,
        ledgerAudio,
        ledgerQueries,
        runId,
      })

      if (RECONCILE_MODE === 'detect_and_adjust') {
        const result = await applyQuotaMovement({
          userId: wallet.user_id,
          deltaAudioSeconds: drift.audioDrift,
          deltaAgentQueries: drift.queryDrift,
          reason: 'adjustment',
          dedupKey: formatReconcileKey(wallet.user_id, runId),
          allowOverdraw: true,
          metadata: {
            audio_drift: drift.audioDrift,
            query_drift: drift.queryDrift,
            run_id: runId,
          },
        })

        if (result.status !== 'already_applied') {
          adjusted++
          const aSign = drift.audioDrift >= 0 ? '+' : ''
          const qSign = drift.queryDrift >= 0 ? '+' : ''
          log(
            `[wallet-reconcile] adjusted user=${wallet.user_id} ` +
            `audio${aSign}${drift.audioDrift}s queries${qSign}${drift.queryDrift}`,
          )
        }
      }
    } catch (err) {
      logger.error('[wallet-reconcile] error processing user', {
        userId: wallet.user_id,
        detail: String(err),
        runId,
      })
    }
  }

  log(
    `[wallet-reconcile] run=${runId} done — ` +
    `checked=${allWallets.length} drifted=${drifted} adjusted=${adjusted}`,
  )
  return { checked: allWallets.length, drifted, adjusted, runId }
}
