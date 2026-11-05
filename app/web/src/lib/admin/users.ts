// Admin user screens (ARC-14a: ADM user management, quota grants, overview). Pure.
// The API decides every guard (§0.9); these only hide controls that would be refused.
import { ApiError } from '../../api/errors'

export type UserStatus = 'active' | 'unverified' | 'disabled'
export interface AdminUser {
  id: string
  email: string
  username: string | null
  role: 'user' | 'admin'
  disabled: boolean
  email_confirmed: boolean
  status: UserStatus
  created_at: string
  last_sign_in_at: string | null
}

export interface UserActions {
  changeRole: boolean
  promote: boolean
  disable: boolean
  enable: boolean
  delete: boolean
  resetPassword: boolean
}

/** Controls for a user row. Never on yourself (the API refuses: 400); the last-admin guard is
 * left to the API, whose refusal is shown as a message. */
export function userActions(user: AdminUser, me: string): UserActions {
  const self = user.id === me
  return {
    changeRole: !self,
    promote: !self && user.role === 'user' && user.status === 'active',
    disable: !self && user.status !== 'disabled',
    enable: !self && user.status === 'disabled',
    delete: !self,
    resetPassword: true,
  }
}

export const MAX_GRANT_MINUTES = 100_000 // app/domain/admin.py
export const MAX_GRANT_QUERIES = 1_000_000

export const BULK_MAX = 50 // app/domain/admin.py BULK_MAX_IDS

/** A typed grant amount (a decimal comma is accepted); undefined = left empty. */
export function grantAmount(s: string): number | undefined {
  const v = s.trim()
  return v === '' ? undefined : Number(v.replace(',', '.'))
}

/** Client check of a quota grant (minutes, queries as typed); null = send it. */
export function grantProblem(minutes: string, queries: string): string | null {
  if ([minutes, queries].some((v) => /^[1-9]\d{0,2}([.,]\d{3})+$/.test(v.trim()))) return 'admin.quota.errors.grouping'
  const m = grantAmount(minutes) ?? 0
  const q = grantAmount(queries) ?? 0
  if (!Number.isFinite(m) || !Number.isFinite(q)) return 'admin.quota.errors.number'
  if (m < 0 || q < 0) return 'admin.quota.errors.negative'
  if (!Number.isInteger(q)) return 'admin.quota.errors.whole'
  if (m > MAX_GRANT_MINUTES || q > MAX_GRANT_QUERIES) return 'admin.quota.errors.tooLarge'
  if (Math.round(m * 60) === 0 && q === 0) return 'admin.quota.errors.empty'
  return null
}

export function adminErrorKey(err: unknown): string {
  if (!(err instanceof ApiError)) return 'admin.errors.generic'
  if (err.status === 0) return 'admin.errors.network'
  if (err.status === 400 || err.status === 422) return 'admin.errors.refused'
  if (err.status === 401 || err.status === 403) return 'admin.errors.forbidden'
  if (err.status === 404) return 'admin.errors.notFound'
  if (err.status === 429) return 'admin.errors.rateLimited'
  if (err.status === 503) return 'admin.errors.unavailable'
  return 'admin.errors.generic'
}

export function bulkSummary(res: unknown): { processed: number; failed: number; skippedSelf: boolean } {
  const r = (typeof res === 'object' && res !== null ? res : {}) as Record<string, unknown>
  return {
    processed: typeof r.processed === 'number' ? r.processed : 0,
    failed: Array.isArray(r.errors) ? r.errors.length : 0,
    skippedSelf: Array.isArray(r.skippedSelf) && r.skippedSelf.length > 0,
  }
}

const REASONS = new Set(['topup', 'admin_grant', 'generate', 'agent_query', 'refund', 'adjustment']) // quota_ledger CHECK

export function ledgerReasonKey(reason: string): string {
  return `admin.quota.reason.${REASONS.has(reason) ? reason : 'other'}`
}

/** `YYYY-MM` for the usage month picker: from a date (UTC) or a typed value (null if invalid). */
export function monthValue(v: Date | string): string | null {
  if (v instanceof Date) return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}`
  const m = /^(\d{4})-(\d{2})$/.exec(v)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  return year >= 1970 && year <= 2100 && month >= 1 && month <= 12 ? v : null // API month_range
}

export type CheckStatus = 'ok' | 'warning' | 'error' | 'unknown'

/** `GET /admin/health` (answers 503 when degraded, with the same body). */
export function healthSummary(body: unknown): { status: 'ok' | 'degraded' | 'unknown'; checks: { name: string; status: CheckStatus }[] } {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const status = b.status === 'ok' || b.status === 'degraded' ? b.status : 'unknown'
  const raw = typeof b.checks === 'object' && b.checks !== null ? (b.checks as Record<string, unknown>) : {}
  const checks = Object.entries(raw).map(([id, c]) => {
    const s = (c as { status?: unknown } | null)?.status
    return { name: checkName(id), status: (s === 'ok' || s === 'warning' || s === 'error' ? s : 'unknown') as CheckStatus }
  })
  return { status, checks }
}

/** API check id → a locale key part: `keys:gemini_api_key` → `gemini`; anything odd → `other`
 * (the id is also free of `:` / `.`, which i18next reads as separators). */
function checkName(id: string): string {
  const name = id.replace(/^keys:/, '').replace(/_api_key$/, '')
  return /^[a-z][a-z0-9_]{0,40}$/.test(name) ? name : 'other'
}
