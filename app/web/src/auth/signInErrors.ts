import { ApiError } from '../api/errors'

const KNOWN = new Set(['invalid_credentials', 'email_not_verified', 'account_disabled'])

/** i18n key for a failed sign-in. Server text is never shown as-is. */
export function signInErrorKey(err: unknown): string {
  if (!(err instanceof ApiError)) return 'auth.errors.generic'
  if (KNOWN.has(err.code)) return `auth.errors.${err.code}`
  if (err.status === 429) return 'auth.errors.rate_limited'
  if (err.code === 'network') return 'auth.errors.network'
  return 'auth.errors.generic'
}
