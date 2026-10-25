// QUO-04 integration tests — concurrency, idempotency, and boundary checks.
//
// REQUIRES: a real Postgres / Supabase instance.
//   Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.
//   Run with: npm run test:integration
//
// These tests call quota_apply_movement() via the Supabase RPC endpoint, which
// routes through PostgREST into Postgres. Promise.all() sends concurrent HTTP
// requests so the race-free conditional UPDATE is exercised against the real DB.
//
// Each test creates an isolated auth.users row and deletes it in cleanup,
// cascading to quota_wallets and quota_ledger.

import { config } from 'dotenv'
config({ path: '.env.local' })

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

// ── Environment ───────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

const SKIP_REASON =
  !SUPABASE_URL || !SERVICE_KEY
    ? 'NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — configure .env.local'
    : undefined

if (SKIP_REASON) {
  console.warn(`[quota-integration] skipping — ${SKIP_REASON}`)
}

// ── Client factory ────────────────────────────────────────────────────────────

function makeDb(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

// ── RPC helper — mirrors applyQuotaMovement.ts ───────────────────────────────

interface MoveParams {
  userId: string
  deltaAudioSeconds?: number
  deltaAgentQueries?: number
  reason: 'topup' | 'admin_grant' | 'generate' | 'agent_query' | 'refund' | 'adjustment'
  dedupKey: string | null
  allowOverdraw?: boolean
  meetingId?: string | null
  metadata?: Record<string, unknown>
}

interface MoveResult {
  status: 'applied' | 'already_applied' | 'insufficient'
  audioRemaining: number
  agentRemaining: number
}

async function move(db: SupabaseClient, p: MoveParams): Promise<MoveResult> {
  const { data, error } = await db.rpc('quota_apply_movement', {
    p_user_id: p.userId,
    p_delta_audio_seconds: p.deltaAudioSeconds ?? 0,
    p_delta_agent_queries: p.deltaAgentQueries ?? 0,
    p_reason: p.reason,
    p_dedup_key: p.dedupKey,
    p_allow_overdraw: p.allowOverdraw ?? false,
    p_meeting_id: p.meetingId ?? null,
    p_created_by: null,
    p_metadata: p.metadata ?? {},
  })
  if (error) throw new Error(`quota_apply_movement RPC: ${JSON.stringify(error)}`)
  const row = (
    data as Array<{ status: string; audio_remaining: string | number; agent_remaining: number }>
  )[0]
  return {
    status: row.status as MoveResult['status'],
    audioRemaining: Number(row.audio_remaining),
    agentRemaining: row.agent_remaining,
  }
}

// ── Wallet helpers ────────────────────────────────────────────────────────────

/** Directly upsert the wallet balance. Service-role bypasses RLS. */
async function setWallet(
  db: SupabaseClient,
  userId: string,
  audio: number,
  queries: number,
): Promise<void> {
  const { error } = await db.from('quota_wallets').upsert(
    { user_id: userId, audio_seconds_remaining: audio, agent_queries_remaining: queries, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' },
  )
  if (error) throw new Error(`setWallet: ${error.message}`)
}

async function getWallet(
  db: SupabaseClient,
  userId: string,
): Promise<{ audio: number; queries: number }> {
  const { data, error } = await db
    .from('quota_wallets')
    .select('audio_seconds_remaining, agent_queries_remaining')
    .eq('user_id', userId)
    .single()
  if (error) throw new Error(`getWallet: ${error.message}`)
  return {
    audio: Number(data!.audio_seconds_remaining),
    queries: data!.agent_queries_remaining,
  }
}

async function countByDedup(db: SupabaseClient, dedupKey: string): Promise<number> {
  const { count, error } = await db
    .from('quota_ledger')
    .select('*', { count: 'exact', head: true })
    .eq('dedup_key', dedupKey)
  if (error) throw new Error(`countByDedup: ${error.message}`)
  return count ?? 0
}

// ── User lifecycle ────────────────────────────────────────────────────────────

async function withUser(
  db: SupabaseClient,
  fn: (userId: string) => Promise<void>,
): Promise<void> {
  const email = `quota-test-${randomUUID()}@test.internal`
  const { data, error } = await db.auth.admin.createUser({
    email,
    password: randomUUID(),
    email_confirm: true,
  })
  if (error || !data.user) throw new Error(`createUser: ${JSON.stringify(error)}`)
  const userId = data.user.id
  try {
    await fn(userId)
  } finally {
    // Delete cascades to quota_wallets + quota_ledger
    await db.auth.admin.deleteUser(userId)
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('QUO-04 quota integration', { skip: SKIP_REASON }, () => {

  // TC-1: Concurrent agent-query charges — only M out of N should succeed
  test('TC-1: concurrent agent charges are race-safe (N=10, M=3)', async () => {
    const db = makeDb()
    await withUser(db, async (userId) => {
      await setWallet(db, userId, 0, 3)

      const N = 10
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          move(db, {
            userId,
            deltaAgentQueries: -1,
            reason: 'agent_query',
            dedupKey: `tc1-${userId}-${i}`,
            allowOverdraw: false,
          }),
        ),
      )

      const applied = results.filter((r) => r.status === 'applied').length
      const insufficient = results.filter((r) => r.status === 'insufficient').length

      assert.equal(applied, 3, `expected exactly 3 applied, got ${applied}`)
      assert.equal(insufficient, N - 3, `expected ${N - 3} insufficient, got ${insufficient}`)

      const wallet = await getWallet(db, userId)
      assert.equal(wallet.queries, 0, 'balance must reach exactly 0')
      assert.ok(wallet.queries >= 0, 'balance must never go negative')
    })
  })

  // TC-2: Concurrent audio-generation reserves — same race-safe guarantee
  test('TC-2: concurrent audio reserves are race-safe (N=8, M=3, 10s each)', async () => {
    const db = makeDb()
    await withUser(db, async (userId) => {
      await setWallet(db, userId, 30, 0) // 30s → exactly 3 × 10s

      const N = 8
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          move(db, {
            userId,
            deltaAudioSeconds: -10,
            reason: 'generate',
            dedupKey: `tc2-${userId}-${i}`,
            allowOverdraw: false,
          }),
        ),
      )

      const applied = results.filter((r) => r.status === 'applied').length
      const insufficient = results.filter((r) => r.status === 'insufficient').length

      assert.equal(applied, 3, `expected exactly 3 applied, got ${applied}`)
      assert.equal(insufficient, N - 3, `expected ${N - 3} insufficient, got ${insufficient}`)

      const wallet = await getWallet(db, userId)
      assert.equal(wallet.audio, 0)
      assert.ok(wallet.audio >= 0, 'audio balance must never go negative')
    })
  })

  // TC-3: Retry-after-restart idempotency via dedup_key
  test('TC-3: same dedup_key applied twice is idempotent', async () => {
    const db = makeDb()
    await withUser(db, async (userId) => {
      await setWallet(db, userId, 0, 100)

      const dedupKey = `tc3-${userId}-idem`

      const r1 = await move(db, { userId, deltaAgentQueries: -5, reason: 'agent_query', dedupKey, allowOverdraw: false })
      assert.equal(r1.status, 'applied')
      assert.equal(r1.agentRemaining, 95)

      // Simulated retry / job re-run with the same dedup key
      const r2 = await move(db, { userId, deltaAgentQueries: -5, reason: 'agent_query', dedupKey, allowOverdraw: false })
      assert.equal(r2.status, 'already_applied')
      assert.equal(r2.agentRemaining, 95, 'balance unchanged on duplicate call')

      // Exactly one ledger row
      const count = await countByDedup(db, dedupKey)
      assert.equal(count, 1, 'dedup_key unique index prevents duplicate ledger row')

      const wallet = await getWallet(db, userId)
      assert.equal(wallet.queries, 95)
    })
  })

  // TC-4a: Settle dedup prevents duplicate settle
  test('TC-4a: settle dedup_key is idempotent (gen:id:settle)', async () => {
    const db = makeDb()
    await withUser(db, async (userId) => {
      await setWallet(db, userId, 1000, 0)
      const meetingId = randomUUID()

      // Reserve 100s
      const r1 = await move(db, {
        userId, deltaAudioSeconds: -100, reason: 'generate',
        dedupKey: `gen:${meetingId}:reserve`, allowOverdraw: false, meetingId,
      })
      assert.equal(r1.status, 'applied')
      assert.equal(r1.audioRemaining, 900)

      // Settle: estimate=100, real=80 → refund 20s over-estimate
      const r2 = await move(db, {
        userId, deltaAudioSeconds: 20, reason: 'generate',
        dedupKey: `gen:${meetingId}:settle`, allowOverdraw: true, meetingId,
      })
      assert.equal(r2.status, 'applied')
      assert.equal(r2.audioRemaining, 920) // 1000 - 100 + 20

      // Second settle call (worker retry) — must not double-credit
      const r3 = await move(db, {
        userId, deltaAudioSeconds: 20, reason: 'generate',
        dedupKey: `gen:${meetingId}:settle`, allowOverdraw: true, meetingId,
      })
      assert.equal(r3.status, 'already_applied')

      const wallet = await getWallet(db, userId)
      assert.equal(wallet.audio, 920, 'no double-settle: balance stays at 920')

      assert.equal(await countByDedup(db, `gen:${meetingId}:settle`), 1)
    })
  })

  // TC-4b: Refund dedup prevents double-refund (both handleJobError and
  //        reconcileStuckReservations use the same gen:id:refund key)
  test('TC-4b: refund dedup_key prevents double-refund (gen:id:refund)', async () => {
    const db = makeDb()
    await withUser(db, async (userId) => {
      await setWallet(db, userId, 1000, 0)
      const meetingId = randomUUID()

      // Reserve 100s (simulating pipeline start)
      await move(db, {
        userId, deltaAudioSeconds: -100, reason: 'generate',
        dedupKey: `gen:${meetingId}:reserve`, allowOverdraw: false, meetingId,
      })

      // First refund caller (e.g. handleJobError in worker)
      const r2 = await move(db, {
        userId, deltaAudioSeconds: 100, reason: 'refund',
        dedupKey: `gen:${meetingId}:refund`, allowOverdraw: false, meetingId,
      })
      assert.equal(r2.status, 'applied')
      assert.equal(r2.audioRemaining, 1000)

      // Second refund caller (e.g. reconcileStuckReservations runs concurrently)
      const r3 = await move(db, {
        userId, deltaAudioSeconds: 100, reason: 'refund',
        dedupKey: `gen:${meetingId}:refund`, allowOverdraw: false, meetingId,
      })
      assert.equal(r3.status, 'already_applied')

      const wallet = await getWallet(db, userId)
      assert.equal(wallet.audio, 1000, 'no double-refund: balance back to 1000, not 1100')

      assert.equal(await countByDedup(db, `gen:${meetingId}:refund`), 1)
    })
  })

  // TC-5: QUO-03 refund-on-failure runs exactly once even if the catch block
  //        fires multiple times
  test('TC-5: QUO-03 agent-query refund-on-failure is idempotent', async () => {
    const db = makeDb()
    await withUser(db, async (userId) => {
      await setWallet(db, userId, 0, 10)
      const msgId = randomUUID()

      // Charge
      const r1 = await move(db, {
        userId, deltaAgentQueries: -1, reason: 'agent_query',
        dedupKey: `agent:${msgId}:charge`, allowOverdraw: false,
      })
      assert.equal(r1.status, 'applied')
      assert.equal(r1.agentRemaining, 9)

      // Refund (answerWithContext threw)
      const r2 = await move(db, {
        userId, deltaAgentQueries: 1, reason: 'refund',
        dedupKey: `agent:${msgId}:refund`, allowOverdraw: false,
      })
      assert.equal(r2.status, 'applied')
      assert.equal(r2.agentRemaining, 10)

      // Repeated catch block — must NOT double-refund
      const r3 = await move(db, {
        userId, deltaAgentQueries: 1, reason: 'refund',
        dedupKey: `agent:${msgId}:refund`, allowOverdraw: false,
      })
      assert.equal(r3.status, 'already_applied')

      const wallet = await getWallet(db, userId)
      assert.equal(wallet.queries, 10, 'balance restored to 10, not overcredited to 11')

      assert.equal(await countByDedup(db, `agent:${msgId}:refund`), 1)
    })
  })

  // TC-6: Successful "not found" answer (NO_CONTEXT_REPLY) leaves the charge in place
  test('TC-6: no-context-reply path keeps the agent-query charge (no refund)', async () => {
    const db = makeDb()
    await withUser(db, async (userId) => {
      await setWallet(db, userId, 0, 10)
      const msgId = randomUUID()

      // Charge only — no refund called (chunks.length === 0 path)
      const r1 = await move(db, {
        userId, deltaAgentQueries: -1, reason: 'agent_query',
        dedupKey: `agent:${msgId}:charge`, allowOverdraw: false,
      })
      assert.equal(r1.status, 'applied')
      assert.equal(r1.agentRemaining, 9)

      const wallet = await getWallet(db, userId)
      assert.equal(wallet.queries, 9, 'charge stands — "not found" is a valid chargeable response')

      const refundCount = await countByDedup(db, `agent:${msgId}:refund`)
      assert.equal(refundCount, 0, 'no refund ledger entry for the no-context path')
    })
  })

  // TC-7: Overdraw boundary
  test('TC-7a: allowOverdraw=true permits negative balance (QUO-02 settle overage)', async () => {
    const db = makeDb()
    await withUser(db, async (userId) => {
      await setWallet(db, userId, 10, 0)
      const meetingId = randomUUID()

      // Reserve exactly the balance
      await move(db, {
        userId, deltaAudioSeconds: -10, reason: 'generate',
        dedupKey: `gen:${meetingId}:reserve`, allowOverdraw: false, meetingId,
      })
      // balance = 0

      // Settle: real duration exceeded estimate (10s estimated, 15s real → delta = -5s overage)
      const settle = await move(db, {
        userId, deltaAudioSeconds: -5, reason: 'generate',
        dedupKey: `gen:${meetingId}:settle`, allowOverdraw: true, meetingId,
      })
      assert.equal(settle.status, 'applied')
      assert.equal(settle.audioRemaining, -5, 'overdraw permitted: balance is -5')
    })
  })

  test('TC-7b: allowOverdraw=false never lets balance go negative, no ledger row on deny', async () => {
    const db = makeDb()
    await withUser(db, async (userId) => {
      await setWallet(db, userId, 5, 0)
      const dedupKey = `tc7b-${userId}`

      const r = await move(db, {
        userId, deltaAudioSeconds: -10, reason: 'generate',
        dedupKey, allowOverdraw: false,
      })
      assert.equal(r.status, 'insufficient')

      const wallet = await getWallet(db, userId)
      assert.equal(wallet.audio, 5, 'balance unchanged when gate denies')

      // No ledger row — the movement did not happen
      assert.equal(await countByDedup(db, dedupKey), 0, 'no ledger row on insufficient')
    })
  })

  // TC-8: Admin grant idempotency (QUO-05)
  test('TC-8: same grant token applies once; distinct tokens stack', async () => {
    const db = makeDb()
    await withUser(db, async (userId) => {
      await setWallet(db, userId, 0, 0)

      const grantA = randomUUID()
      const grantB = randomUUID()

      // Grant A — first time
      const r1 = await move(db, {
        userId, deltaAgentQueries: 1000, reason: 'admin_grant',
        dedupKey: grantA, allowOverdraw: true,
      })
      assert.equal(r1.status, 'applied')
      assert.equal(r1.agentRemaining, 1000)

      // Grant A — duplicate (same form submission) → no-op
      const r2 = await move(db, {
        userId, deltaAgentQueries: 1000, reason: 'admin_grant',
        dedupKey: grantA, allowOverdraw: true,
      })
      assert.equal(r2.status, 'already_applied')
      assert.equal(r2.agentRemaining, 1000, 'duplicate grant changes nothing')

      // Grant B — different token → stacks
      const r3 = await move(db, {
        userId, deltaAgentQueries: 1000, reason: 'admin_grant',
        dedupKey: grantB, allowOverdraw: true,
      })
      assert.equal(r3.status, 'applied')
      assert.equal(r3.agentRemaining, 2000, 'two distinct grant tokens stack correctly')

      assert.equal(await countByDedup(db, grantA), 1)
      assert.equal(await countByDedup(db, grantB), 1)
    })
  })
})
