// POST /api/admin/keys/healthcheck — manually run the API key health check.
// GET  /api/admin/keys/healthcheck — return the last run timestamp (no probing).
//
// SECURITY:
// - Admin only.
// - Probes each stored key against a cheap authenticated provider endpoint and
//   records only the verdict (healthy | unhealthy | unknown) + a short detail.
// - Plaintext / ciphertext are never returned.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/server'
import { runHealthCheck, getLastHealthCheckAt } from '@/lib/keys/healthcheck-runner'
import { writeAuditLog, requestContext } from '@/lib/admin/audit'
import { logger } from '@/lib/logger'

export async function GET(req: NextRequest) {
  try { await requireAdmin(req) } catch (res) { return res as NextResponse }

  const lastCheckedAt = await getLastHealthCheckAt()
  return NextResponse.json({ lastCheckedAt })
}

export async function POST(req: NextRequest) {
  let caller: { id: string; email?: string }
  try { caller = await requireAdmin(req) } catch (res) { return res as NextResponse }

  let result
  try {
    result = await runHealthCheck()
  } catch (err) {
    logger.error('[admin/keys/healthcheck] run failed', {
      detail: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: 'Health check failed to run.' }, { status: 500 })
  }

  void writeAuditLog({
    actorId:    caller.id,
    actorEmail: caller.email ?? '',
    action:     'admin_config.healthcheck',
    targetType: 'admin_config',
    targetId:   '',
    metadata:   { summary: result.summary },
    ...requestContext(req),
  })

  return NextResponse.json({
    ranAt:   result.ranAt,
    summary: result.summary,
    keys:    result.keys,
  })
}
