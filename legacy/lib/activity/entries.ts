// Pure builders for activity_log entries that need special handling. No I/O.

/**
 * `meeting_deleted` is logged AFTER the meeting row is gone. activity_log.meeting_id is an FK to
 * meetings (migration 016), so referencing the deleted row there makes the insert fail (23503) —
 * silently, because logActivity is fire-and-forget (BUG-012). Keep the id in metadata instead
 * (an identifier, not content — allowed by CLAUDE.md §9g).
 */
export function meetingDeletedActivity(meetingId: string): {
  eventType: 'meeting_deleted'
  meetingId: null
  metadata: { meeting_id: string }
} {
  return { eventType: 'meeting_deleted', meetingId: null, metadata: { meeting_id: meetingId } }
}
