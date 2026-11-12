// POST /api/admin/pipeline/reconcile-quota
//
// Admin-only manual trigger for the QUO-02 reconciliation sweep.
// Finds meetings stuck in 'processing' > STUCK_TIMEOUT_MINUTES with an
// unredeemed quota reservation, refunds each, and marks them failed.
//
// Safe to call multiple times — the sweep is fully idempotent.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/server'
import { reconcileStuckReservations } from '@/lib/quota/reconcile'
import { writeAuditLog, requestContext } from '@/lib/admin/audit'

export async function POST(req: NextRequest): Promise<NextResponse> {
  let actor
  try {
    actor = await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  const { reconciled } = await reconcileStuckReservations()

  const ctx = requestContext(req)
  writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email ?? '',
    action: 'quota.reconcile',
    targetType: 'pipeline',
    targetId: 'quota-sweep',
    metadata: { reconciled },
    ...ctx,
  })

  return NextResponse.json({ ok: true, reconciled })
}
