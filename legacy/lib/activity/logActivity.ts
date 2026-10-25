// SERVER ONLY — uses the service-role key. Never import from client components.
//
// Central fire-and-forget helper for writing activity_log rows.
// A logging failure must NEVER break the user action being recorded.
// Pattern mirrors lib/admin/audit.ts → writeAuditLog().

import { createServerClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import type { ActivityEventType } from './types'

export interface ActivityEntry {
  userId: string
  eventType: ActivityEventType
  meetingId?: string | null
  /** Future: the user a meeting was shared with. null until sharing ships. */
  targetUserId?: string | null
  /** Small non-content metadata only. Never include summary/transcript/notes. */
  metadata?: Record<string, unknown> | null
  ip?: string | null
  userAgent?: string | null
}

/**
 * Write one row to activity_log using the service-role client.
 * Fire-and-forget: never throws, never blocks the caller.
 */
export function logActivity(entry: ActivityEntry): void {
  void (async () => {
    try {
      const db = createServerClient()
      const { error } = await db.from('activity_log').insert({
        user_id:        entry.userId,
        event_type:     entry.eventType,
        meeting_id:     entry.meetingId    ?? null,
        target_user_id: entry.targetUserId ?? null,
        metadata:       entry.metadata     ?? null,
        ip:             entry.ip           ?? null,
        user_agent:     entry.userAgent    ?? null,
      })
      if (error) logger.error('[activity] insert failed', { detail: error.message })
    } catch (err) {
      logger.error('[activity] unexpected error', { detail: String(err) })
    }
  })()
}
