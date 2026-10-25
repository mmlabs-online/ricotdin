// Pure guard functions for admin user-management operations.
// No I/O — fully unit-testable in isolation.
// Every guard returns { ok: true } on pass, or { ok: false, status, message } on block.

export type GuardOk = { ok: true }
export type GuardFail = { ok: false; status: 400; message: string }
export type GuardResult = GuardOk | GuardFail

/**
 * Returns true if app_metadata indicates an admin role.
 * Used by requireAdmin in lib/auth/server.ts; extracted here for testability.
 * A non-admin caller → HTTP 403.
 */
export function checkAdminRole(appMetadata: Record<string, unknown>): boolean {
  return (appMetadata as { role?: string }).role === 'admin'
}

/**
 * Guard for role changes.
 * - Promotions (user → admin) always pass.
 * - Demotions (admin → user) block if:
 *   (a) target is the caller themselves, or
 *   (b) the target is the only remaining admin.
 *
 * adminCount = total profiles with role='admin' (including the target, BEFORE the change).
 */
export function guardRoleDemotion(
  callerId: string,
  targetId: string,
  targetCurrentRole: string,
  newRole: string,
  adminCount: number,
): GuardResult {
  // Not a demotion — always OK
  if (!(targetCurrentRole === 'admin' && newRole === 'user')) return { ok: true }

  if (targetId === callerId) {
    return { ok: false, status: 400, message: 'You cannot demote yourself.' }
  }
  if (adminCount <= 1) {
    return { ok: false, status: 400, message: 'Cannot demote the last remaining admin.' }
  }
  return { ok: true }
}

/**
 * Guard for disabling an account.
 * Blocks self-disable and disabling the last remaining admin.
 *
 * targetRole = the role held by the target user right now.
 * adminCount = total profiles with role='admin' (including the target).
 */
export function guardDisable(
  callerId: string,
  targetId: string,
  targetRole: string,
  adminCount: number,
): GuardResult {
  if (targetId === callerId) {
    return { ok: false, status: 400, message: 'You cannot disable your own account.' }
  }
  if (targetRole === 'admin' && adminCount <= 1) {
    return { ok: false, status: 400, message: 'Cannot disable the last remaining admin.' }
  }
  return { ok: true }
}

/**
 * Guard for deleting an account.
 * Blocks self-delete and deleting the last remaining admin.
 */
export function guardDelete(
  callerId: string,
  targetId: string,
  targetRole: string,
  adminCount: number,
): GuardResult {
  if (targetId === callerId) {
    return { ok: false, status: 400, message: 'You cannot delete your own account.' }
  }
  if (targetRole === 'admin' && adminCount <= 1) {
    return { ok: false, status: 400, message: 'Cannot delete the last remaining admin.' }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Bulk-action helpers (ADM-09)
// ---------------------------------------------------------------------------

export type BulkAction = 'disable' | 'enable' | 'set_role'
type BulkRole = 'user' | 'admin'

export type BulkBodyOk = {
  ok: true
  ids: string[]
  action: BulkAction
  role?: BulkRole
}
export type BulkBodyFail = { ok: false; status: 422; message: string }
export type BulkBodyResult = BulkBodyOk | BulkBodyFail

const VALID_ACTIONS: BulkAction[] = ['disable', 'enable', 'set_role']
const VALID_ROLES: BulkRole[]     = ['user', 'admin']

/**
 * Validates a parsed JSON body for bulk-action endpoints.
 * Returns typed ids + action on success, or { ok: false, status: 422 } on invalid input.
 */
export function validateBulkActionBody(body: unknown): BulkBodyResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 422, message: 'Request body must be a JSON object.' }
  }
  const b = body as Record<string, unknown>

  const ids = b['ids']
  if (!Array.isArray(ids) || ids.length === 0) {
    return { ok: false, status: 422, message: 'ids must be a non-empty array.' }
  }
  if (ids.length > 50) {
    return { ok: false, status: 422, message: 'ids may not exceed 50 entries per request.' }
  }

  const action = b['action'] as BulkAction
  if (!VALID_ACTIONS.includes(action)) {
    return { ok: false, status: 422, message: `action must be one of: ${VALID_ACTIONS.join(', ')}.` }
  }

  if (action === 'set_role') {
    const role = b['role'] as BulkRole
    if (!VALID_ROLES.includes(role)) {
      return { ok: false, status: 422, message: `role must be one of: ${VALID_ROLES.join(', ')}.` }
    }
    return { ok: true, ids: ids as string[], action, role }
  }

  return { ok: true, ids: ids as string[], action }
}

/**
 * Removes the caller's own ID from the target list.
 * Returns the safe subset and a flag indicating whether a self-attempt was blocked.
 */
export function excludeSelf(
  callerId: string,
  targetIds: string[],
): { safe: string[]; selfAttempted: boolean } {
  const safe = targetIds.filter((id) => id !== callerId)
  return { safe, selfAttempted: safe.length < targetIds.length }
}
