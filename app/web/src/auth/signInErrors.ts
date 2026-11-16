import { ApiError } from '../api/errors'

// mmlabs sign-in codes (AUT-05) and ricotdin's own refusals after a valid token (/auth/me).
const KNOWN = new Set([
  'invalid_credentials',
  'account_disabled',
  'account_link_conflict',
  'turnstile_required',
  'turnstile_failed',
])

/** i18n key for a failed sign-in. Server text is never shown as-is. */
export function signInErrorKey(err: unknown): string {
  if (!(err instanceof ApiError)) return 'auth.errors.generic'
  if (KNOWN.has(err.code)) return `auth.errors.${err.code}`
  if (err.status === 429) return 'auth.errors.rate_limited'
  if (err.code === 'network') return 'auth.errors.network'
  return 'auth.errors.generic'
}

/** mmlabs asks for a Turnstile challenge after repeated failures for an email. */
export function needsTurnstile(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 'turnstile_required' || err.code === 'turnstile_failed')
}
