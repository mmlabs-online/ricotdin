// Pure guards for the activity system. No I/O — safe to unit-test.

/**
 * Returns true only when the caller's userId exactly matches the
 * requested userId. Used by POST /api/activity to prevent one user
 * from logging events on behalf of another.
 */
export function isCallerOwn(callerUserId: string, requestedUserId: string): boolean {
  return !!requestedUserId && callerUserId === requestedUserId
}
