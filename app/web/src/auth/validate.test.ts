import { describe, expect, it } from 'vitest'
import { newPasswordError, passwordField, normalizeEmail, normalizeUsername, validateEmail, validatePassword, validateUsername } from './validate'

// Same rules as app/api/app/auth/validate.py (the API decides; this only saves a round trip).
describe('auth validation (i18n keys)', () => {
  it('username: 3–30 of a-z 0-9 _ -, lowercased', () => {
    expect(normalizeUsername('  Alice_1 ')).toBe('alice_1')
    expect(validateUsername('ab')).toBe('auth.validation.usernameShort')
    expect(validateUsername('a'.repeat(31))).toBe('auth.validation.usernameLong')
    expect(validateUsername('al ice')).toBe('auth.validation.usernameChars')
    expect(validateUsername('Alice')).toBe('auth.validation.usernameChars') // expects the normalized form
    expect(validateUsername('alice-1_x')).toBeNull()
  })
  it('email: one plain address', () => {
    expect(normalizeEmail(' A@B.Co ')).toBe('a@b.co')
    for (const bad of ['', 'a', 'a@b', 'a@b.c', 'A <a@b.co>', 'a..b@c.co', 'a@b.co,c@d.co', `${'x'.repeat(250)}@b.co`]) {
      expect(validateEmail(bad), bad).toBe('auth.validation.email')
    }
    expect(validateEmail('alex.morgan+x@acme.com')).toBeNull()
  })
  it('password: 8–256 characters', () => {
    expect(validatePassword('1234567')).toBe('auth.validation.passwordShort')
    expect(validatePassword('x'.repeat(257))).toBe('auth.validation.passwordLong')
    expect(validatePassword('12345678')).toBeNull()
  })
})

describe('newPasswordError (reset + SEC-05 verify)', () => {
  it('checks the rules first, then that both fields match', () => {
    expect(newPasswordError('short', 'short')).toBe('auth.validation.passwordShort')
    expect(newPasswordError('long-enough-1', 'long-enough-2')).toBe('auth.validation.mismatch')
    expect(newPasswordError('long-enough-1', 'long-enough-1')).toBeNull()
  })
})

describe('passwordField', () => {
  it('ties a mismatch to the confirmation field and every other rule to the password field', () => {
    expect(passwordField('auth.validation.mismatch')).toBe('repeat')
    expect(passwordField('auth.validation.passwordShort')).toBe('password')
    expect(passwordField('auth.validation.passwordLong')).toBe('password')
  })
})
