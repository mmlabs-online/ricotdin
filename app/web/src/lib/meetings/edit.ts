// Editing a meeting's summary / notes (PRO-06). Pure, except contentHash (Web Crypto).
import { ApiError } from '../../api/errors'
import { canRename, type MeetingRole } from '../access/roles'

/** sha-256 hex of the UTF-8 text, the API's `content_hash`: a save carries the hash of the text
 *  it started from, so it never overwrites a change made in the meantime (409). */
export async function contentHash(text: string | null): Promise<string> {
  const bytes = new TextEncoder().encode(text ?? '')
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Owner or editor (like rename), and only once the meeting is finished (the API answers 409). */
export function canEditContent(role: MeetingRole, status: string): boolean {
  return canRename(role) && status === 'done'
}

export function isDirty(original: string | null, draft: string): boolean {
  return (original ?? '') !== draft
}

export function editErrorKey(err: unknown): string {
  if (!(err instanceof ApiError)) return 'detail.edit.errors.failed'
  if (err.status === 0) return 'detail.errors.network'
  if (err.status === 429) return 'detail.errors.rateLimited'
  if (err.status === 403) return 'detail.errors.forbidden'
  if (err.code === 'content_changed') return 'detail.edit.errors.changed'
  if (err.status === 409) return 'detail.edit.errors.notDone'
  if (err.code === 'invalid_characters') return 'detail.edit.errors.characters'
  if (err.status === 422) return 'detail.edit.errors.invalid'
  return 'detail.edit.errors.failed'
}
