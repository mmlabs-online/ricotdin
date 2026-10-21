// SERVER ONLY — uses service role key. Never import from client components.
//
// Central helper for writing audit log entries.
// All calls are fire-and-forget: errors are logged but never thrown,
// so a logging failure can never break the operation being audited.

import { createServerClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'

export interface AuditEntry {
  /** null for system actions (e.g. the PRV-02 retention job); actor_email then names the job. */
  actorId: string | null
  actorEmail: string
  /** Dot-namespaced action. e.g. 'meeting.requeue', 'user.role_change' */
  action: string
  /** 'user' | 'meeting' */
  targetType: string
  /** UUID as a string */
  targetId: string
  metadata?: Record<string, unknown>
  ipAddress?: string | null
  userAgent?: string | null
}

/**
 * Write one row to audit_logs using the service-role client.
 * Never throws — failures are logged to stderr and silently swallowed.
 */
export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  try {
    const db = createServerClient()
    const { error } = await db.from('audit_logs').insert({
      actor_id: entry.actorId,
      actor_email: entry.actorEmail,
      action: entry.action,
      target_type: entry.targetType,
      target_id: entry.targetId,
      metadata: entry.metadata ?? {},
      ip_address: entry.ipAddress ?? null,
      user_agent: entry.userAgent ?? null,
    })
    if (error) {
      logger.error('[audit] insert failed', { detail: error.message })
    }
  } catch (err) {
    logger.error('[audit] unexpected error', { detail: String(err) })
  }
}

/**
 * Extract IP + User-Agent from a request for audit context.
 * Only attaches best-effort values; never throws.
 */
export function requestContext(req: { headers: { get(key: string): string | null } }): {
  ipAddress: string | null
  userAgent: string | null
} {
  return {
    ipAddress:
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      req.headers.get('x-real-ip') ??
      null,
    userAgent: req.headers.get('user-agent') ?? null,
  }
}
