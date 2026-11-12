// Pure helpers for wallet reconciliation. No I/O — fully unit-testable.

export interface WalletDrift {
  /** ledger_sum - wallet_value. Positive means wallet is behind the ledger. */
  audioDrift: number
  queryDrift: number
  hasDrift: boolean
}

/**
 * Compute the drift between a wallet's cached balance and the ground-truth
 * ledger sum. Returns the correction deltas needed to bring the wallet in line.
 *
 * Positive drift: wallet is under-reported → adjustment adds credit.
 * Negative drift: wallet is over-reported → adjustment removes credit.
 */
export function computeWalletDrift(
  walletAudio: number,
  walletQueries: number,
  ledgerAudio: number,
  ledgerQueries: number,
): WalletDrift {
  const audioDrift = ledgerAudio - walletAudio
  const queryDrift = ledgerQueries - walletQueries
  return {
    audioDrift,
    queryDrift,
    hasDrift: audioDrift !== 0 || queryDrift !== 0,
  }
}

/**
 * Builds the dedup key for a reconciliation adjustment.
 * Scoping by runId ensures the same run cannot apply two adjustments for the
 * same user, and a new run starts fresh.
 */
export function formatReconcileKey(userId: string, runId: string): string {
  return `reconcile:${userId}:${runId}`
}
