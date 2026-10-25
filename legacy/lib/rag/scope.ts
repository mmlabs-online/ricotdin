// Pure helpers for chat scope derivation — no I/O, fully testable.
// Three scopes: meeting (one meeting), folder (set of meetings), global (all).

/**
 * Derive the meetingIds filter array to pass to retrieveContext().
 *
 * - Single meeting:  meetingId set → [meetingId]
 * - Folder scope:    folderMeetingIds set (possibly empty) → folderMeetingIds
 * - Global scope:    both null → null (no filter; RLS enforces access)
 */
export function deriveMeetingIds(
  meetingId: string | null,
  folderMeetingIds: string[] | null,
): string[] | null {
  if (meetingId) return [meetingId]
  if (folderMeetingIds !== null) return folderMeetingIds
  return null
}

/**
 * Validate that at most one scope anchor is set.
 * Returns an error message string, or null if valid.
 */
export function validateChatScope(
  meetingId: string | null,
  folderId: string | null,
): string | null {
  if (meetingId && folderId) {
    return 'Provide meetingId or folderId, not both.'
  }
  return null
}

/** The three ways a chat request resolves after retrieval. */
export type ChatOutcome = 'answer' | 'no_context' | 'retrieval_error'

/**
 * Decide how to respond after the retrieval step.
 *
 * IMPORTANT: a technical retrieval failure (embedding/RPC threw) must NOT be
 * reported as "no relevant information" — that masks a real outage as an empty
 * result. `retrievalFailed` therefore takes precedence over the chunk count.
 *
 * - retrievalFailed        → 'retrieval_error' (surface a clear message, refund)
 * - no failure, 0 chunks   → 'no_context'      (genuinely nothing relevant)
 * - no failure, >0 chunks  → 'answer'          (synthesize from context)
 */
export function classifyChatOutcome(
  retrievalFailed: boolean,
  chunkCount: number,
): ChatOutcome {
  if (retrievalFailed) return 'retrieval_error'
  if (chunkCount === 0) return 'no_context'
  return 'answer'
}
