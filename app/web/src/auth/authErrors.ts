import { ApiError } from '../api/errors'

/** i18n key for a failed signed-out auth call (register / verify / reset). Never server text. */
export function publicAuthErrorKey(err: unknown, context: 'register' | 'verify' | 'reset'): string {
  if (!(err instanceof ApiError)) return 'auth.errors.generic'
  if (err.code === 'network') return 'auth.errors.network'
  if (err.status === 429) return 'auth.errors.rate_limited'
  if (err.status === 503) return 'auth.errors.unavailable'
  if (err.code === 'invalid_token') return 'auth.errors.invalidLink'
  if (context === 'register' && err.status === 409) return 'auth.register.taken'
  if (err.status === 422) return context === 'register' ? 'auth.register.invalid' : 'auth.validation.passwordShort'
  return 'auth.errors.generic'
}
