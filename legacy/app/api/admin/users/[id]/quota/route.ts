// GET  /api/admin/users/:id/quota — wallet balance + 20 most-recent ledger rows (admin-only)
// POST /api/admin/users/:id/quota — grant audio minutes and/or agent queries (admin-only)
//
// All balance writes go through quota_apply_movement (SECURITY DEFINER).
// The per-submission grantId (randomUUID on server) makes each POST idempotent:
// a network retry of the exact same HTTP request gets 'already_applied' → still 200.
// Two deliberate clicks generate two separate UUIDs → both grants apply (intended).
//
// SECURITY: requireAdmin enforces admin role. Service-role client bypasses RLS.

import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/server'
import { applyQuotaMovement } from '@/lib/quota/applyQuotaMovement'
import { writeAuditLog, requestContext } from '@/lib/admin/audit'
import { logger } from '@/lib/logger'

// ---------------------------------------------------------------------------
// GET — balance + recent ledger (admin view of any user)
// ---------------------------------------------------------------------------

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  const { id: targetId } = await params
  const db = createServerClient()

  const [walletRes, ledgerRes] = await Promise.all([
    db
      .from('quota_wallets')
      .select('audio_seconds_remaining, agent_queries_remaining, updated_at')
      .eq('user_id', targetId)
      .maybeSingle(),
    db
      .from('quota_ledger')
      .select('id, created_at, reason, delta_audio_seconds, delta_agent_queries, created_by, metadata')
      .eq('user_id', targetId)
      .order('created_at', { ascending: false })
      .limit(20),
  ])

  if (walletRes.error) logger.error('[admin/quota] wallet error', { detail: walletRes.error.message })
  if (ledgerRes.error) logger.error('[admin/quota] ledger error', { detail: ledgerRes.error.message })

  return NextResponse.json({
    wallet: walletRes.data
      ? {
          audio_seconds_remaining: Number(walletRes.data.audio_seconds_remaining),
          agent_queries_remaining: walletRes.data.agent_queries_remaining,
          updated_at: walletRes.data.updated_at,
        }
      : { audio_seconds_remaining: 0, agent_queries_remaining: 0, updated_at: null },
    ledger: ledgerRes.data ?? [],
  })
}

// ---------------------------------------------------------------------------
// POST — admin grant
// ---------------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let actor
  try {
    actor = await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  const { id: targetId } = await params

  let body: { audio_minutes?: unknown; agent_queries?: unknown; note?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const audioMinutes = typeof body.audio_minutes === 'number' ? body.audio_minutes : 0
  const agentQueries = typeof body.agent_queries === 'number' ? body.agent_queries : 0
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : undefined

  if (audioMinutes < 0 || agentQueries < 0) {
    return NextResponse.json({ error: 'Values must be non-negative.' }, { status: 400 })
  }
  if (audioMinutes === 0 && agentQueries === 0) {
    return NextResponse.json({ error: 'Provide at least one positive value.' }, { status: 400 })
  }

  // Per-submission idempotency token: generated server-side.
  // Retries of the exact same network request get already_applied (treated as success).
  const grantId = randomUUID()

  const result = await applyQuotaMovement({
    userId: targetId,
    deltaAudioSeconds: Math.round(audioMinutes * 60),
    deltaAgentQueries: agentQueries,
    reason: 'admin_grant',
    dedupKey: grantId,
    allowOverdraw: true,
    createdBy: actor.id,
    metadata: { note: note ?? null, grant_id: grantId },
  })

  const ctx = requestContext(req)
  writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email ?? '',
    action: 'quota.grant',
    targetType: 'user',
    targetId,
    metadata: {
      audio_minutes: audioMinutes,
      agent_queries: agentQueries,
      note: note ?? null,
      grant_id: grantId,
    },
    ...ctx,
  })

  return NextResponse.json({
    ok: true,
    grantId,
    audioRemaining: result.audioRemaining,
    agentRemaining: result.agentRemaining,
  })
}
