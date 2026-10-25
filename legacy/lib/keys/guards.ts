// Pure functions — no I/O, suitable for unit tests.

import type { AdminConfigRow, MaskedAdminConfig } from '@/types/database'

/**
 * Returns true when there is at most 1 active entry for a config_key.
 * Used to block disabling or deleting the last active key.
 */
export function isLastActiveKey(activeCount: number): boolean {
  return activeCount <= 1
}

/**
 * Convert a full admin_config DB row to the safe display shape.
 *
 * SECURITY: intentionally omits value_ciphertext, value_iv, value_auth_tag,
 * and created_by. These must never appear in API responses or logs.
 */
export function maskAdminConfig(row: AdminConfigRow): MaskedAdminConfig {
  return {
    id:              row.id,
    created_at:      row.created_at,
    config_key:      row.config_key,
    label:           row.label,
    last4:           row.last4,
    status:          row.status,
    disabled_reason: row.disabled_reason,
    last_used_at:    row.last_used_at,
    health_status:     row.health_status,
    health_checked_at: row.health_checked_at,
    health_detail:     row.health_detail,
  }
}
