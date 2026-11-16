// Profile screen rules (ARC-13c: PRF-01..04, QUO display, AIP-06 default model). Pure.
import { ApiError } from '../../api/errors'

/** A quota balance in seconds as whole hours and minutes (the API value may be negative). */
export function quotaParts(seconds: number): { hours: number; minutes: number } {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  return { hours: Math.floor(s / 3600), minutes: Math.floor((s % 3600) / 60) }
}

/** `<select>` value of a model pair; '' = no personal default (the system default applies). */
export function modelValue(provider: string | null, model: string | null): string {
  return provider && model ? `${provider}:${model}` : ''
}

export function parseModelValue(value: string): { provider: string | null; model: string | null } {
  const at = value.indexOf(':')
  if (at <= 0 || at === value.length - 1) return { provider: null, model: null }
  return { provider: value.slice(0, at), model: value.slice(at + 1) }
}

export type ProfileForm = 'details' | 'model' | 'folder' | 'avatar'

export function profileErrorKey(form: ProfileForm, err: unknown): string {
  if (!(err instanceof ApiError)) return 'profile.errors.generic'
  if (err.status === 0) return 'profile.errors.network'
  if (err.status === 429) return 'profile.errors.rateLimited'
  if (form === 'details') {
    if (err.status === 409) return 'profile.errors.usernameTaken'
    if (err.status === 400 || err.status === 422) return 'profile.errors.invalid'
  }
  if (form === 'model' && err.status === 400) return 'profile.errors.modelNotAllowed'
  if (form === 'folder' && (err.status === 404 || err.status === 422)) return 'profile.errors.folderUnavailable'
  return 'profile.errors.generic'
}
