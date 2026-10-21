// Shared event-type definitions for the activity_log table.
// Import from both server and client code (no side-effects, pure constants).

/**
 * All recognised activity event types.
 *
 * meeting_viewed is intentionally ABSENT — viewing is too noisy and low-value.
 *
 * meeting_shared / meeting_unshared are present in the schema and this set
 * so the instrumentation hooks light up automatically when sharing ships.
 * The actual logActivity() calls are marked TODO(sharing) in the share routes.
 */
export const ALLOWED_EVENT_TYPES = new Set<string>([
  // Auth
  'login',
  'logout',

  // Recording lifecycle — client best-effort (via POST /api/activity)
  'record_start',
  'record_stop',
  // COM-01: user acknowledged the recording notice before starting
  'recording_notice_ack',

  // Meeting lifecycle — server-side
  'meeting_created',
  'processing_done',
  'processing_failed',
  'chat_message',
  'meeting_deleted',

  // Share events — schema + whitelist ready; instrumentation is TODO(sharing)
  'meeting_shared',
  'meeting_unshared',
])

export type ActivityEventType =
  | 'login'
  | 'logout'
  | 'record_start'
  | 'record_stop'
  | 'recording_notice_ack'
  | 'meeting_created'
  | 'processing_done'
  | 'processing_failed'
  | 'chat_message'
  | 'meeting_deleted'
  | 'meeting_shared'    // future
  | 'meeting_unshared'  // future

/** Client endpoint: only these event types may be submitted by the browser. */
export const CLIENT_EVENT_TYPES = new Set<string>([
  'record_start',
  'record_stop',
  'recording_notice_ack',
])

/** Returns true iff the event type is in the allowed set. */
export function validateEventType(type: string): boolean {
  return ALLOWED_EVENT_TYPES.has(type)
}
