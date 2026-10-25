// SERVER ONLY — uses the service-role client (bypasses RLS).
// This is the single entry point for all quota balance changes.
// QUO-02 (generate) and QUO-03 (ask-agent) will call this function directly;
// do not duplicate balance logic in application code.

import { createServerClient } from '@/lib/supabase/server'
import { errorToMessage } from '@/lib/logger'

export type QuotaMovementStatus = 'applied' | 'already_applied' | 'insufficient'

export type QuotaMovementReason =
  | 'topup'
  | 'admin_grant'
  | 'generate'
  | 'agent_query'
  | 'refund'
  | 'adjustment'

export interface QuotaMovementParams {
  userId: string
  /** Positive to top up; negative to consume. Stored in seconds. */
  deltaAudioSeconds: number
  /** Positive to top up; negative to consume. */
  deltaAgentQueries: number
  reason: QuotaMovementReason
  /**
   * Required for consumption calls so retries are idempotent.
   * Use a stable key scoped to the job+step, e.g. `meeting:${meetingId}:generate`.
   * Leave null for manual top-ups / admin grants.
   */
  dedupKey?: string | null
  /**
   * When false (default), the update fails with 'insufficient' if either axis
   * would go below zero. Set true only for post-generate duration settle where
   * a small estimation error is acceptable.
   */
  allowOverdraw?: boolean
  meetingId?: string | null
  /** Admin user id for manual grants; omit for automated consumption. */
  createdBy?: string | null
  /** Non-content metadata, e.g. { duration_source: 'ffprobe_estimate' }. */
  metadata?: Record<string, unknown>
}

export interface QuotaMovementResult {
  /** Discriminated outcome — switch on this to decide next action. */
  status: QuotaMovementStatus
  /** Wallet balance after the operation (or current balance when insufficient). */
  audioRemaining: number
  agentRemaining: number
}

/**
 * Atomically moves quota balances for a user via the `quota_apply_movement`
 * Postgres function (SECURITY DEFINER). All correctness guarantees — race-free
 * gate, idempotency, ledger append — live in the DB function, not here.
 *
 * Throws on unexpected DB/network errors. Callers must handle the 'insufficient'
 * status themselves (e.g. return HTTP 402 to the browser).
 */
export async function applyQuotaMovement(
  params: QuotaMovementParams,
): Promise<QuotaMovementResult> {
  const supabase = createServerClient()

  // The DB columns are bigint/int. A fractional delta (e.g. from Speechmatics'
  // fractional end_time) makes Postgres reject the value with 22P02. Coerce to
  // whole units here as a defensive backstop so no caller can trigger that —
  // callers should still pass integers with the correct rounding intent.
  const deltaAudio = Math.round(params.deltaAudioSeconds)
  const deltaAgent = Math.round(params.deltaAgentQueries)

  const { data, error } = await supabase.rpc('quota_apply_movement', {
    p_user_id: params.userId,
    // PostgREST serialises numbers as JSON numbers, which Postgres accepts for
    // bigint when the value is within Number.MAX_SAFE_INTEGER (~9 quadrillion
    // seconds). Audio second values are always well within this range.
    p_delta_audio_seconds: deltaAudio,
    p_delta_agent_queries: deltaAgent,
    p_reason: params.reason,
    p_dedup_key: params.dedupKey ?? null,
    p_allow_overdraw: params.allowOverdraw ?? false,
    p_meeting_id: params.meetingId ?? null,
    p_created_by: params.createdBy ?? null,
    p_metadata: params.metadata ?? {},
  })

  // Wrap the raw Supabase PostgrestError (a plain object) in a real Error so it
  // never logs as "[object Object]" upstream and carries the code/details.
  if (error) throw new Error(`apply_quota_movement RPC failed: ${errorToMessage(error)}`)

  // RETURNS TABLE functions come back as an array; we always get exactly one row.
  const rows = data as Array<{
    status: string
    audio_remaining: string | number  // PostgREST may send bigint as string
    agent_remaining: number
  }>

  const row = rows[0]

  return {
    status: row.status as QuotaMovementStatus,
    audioRemaining: Number(row.audio_remaining),
    agentRemaining: row.agent_remaining,
  }
}
