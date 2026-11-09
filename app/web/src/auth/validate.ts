// Auth input checks (ARC-13a), the same rules as app/api/app/auth/validate.py. The API decides;
// these only give an instant message. Results are i18n keys.

const USERNAME = /^[a-z0-9_-]+$/
const EMAIL = /^[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/
export const MIN_PASSWORD = 8
export const MAX_PASSWORD = 256

export function normalizeUsername(raw: string): string {
  return raw.toLowerCase().trim()
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

export function validateUsername(username: string): string | null {
  if (username.length < 3) return 'auth.validation.usernameShort'
  if (username.length > 30) return 'auth.validation.usernameLong'
  if (!USERNAME.test(username)) return 'auth.validation.usernameChars'
  return null
}

export function validateEmail(email: string): string | null {
  if (email.length > 254 || !EMAIL.test(email) || email.includes('..')) return 'auth.validation.email'
  return null
}

export function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD) return 'auth.validation.passwordShort'
  if (password.length > MAX_PASSWORD) return 'auth.validation.passwordLong'
  return null
}

/** A new password and its confirmation (reset, and the verify link that sets it, SEC-05). */
export function newPasswordError(password: string, confirm: string): string | null {
  return validatePassword(password) ?? (confirm !== password ? 'auth.validation.mismatch' : null)
}

/** Which field a new-password error belongs to, so only that field is marked invalid. */
export function passwordField(errorKey: string): 'password' | 'repeat' {
  return errorKey === 'auth.validation.mismatch' ? 'repeat' : 'password'
}
