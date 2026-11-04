import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/errors'
import { modelValue, parseModelValue, passwordProblem, profileErrorKey, quotaParts } from './profile'

describe('quotaParts', () => {
  it('hours and minutes, never negative (the raw balance may be)', () => {
    expect(quotaParts(3 * 3600 + 25 * 60 + 59)).toEqual({ hours: 3, minutes: 25 })
    expect(quotaParts(59)).toEqual({ hours: 0, minutes: 0 })
    expect(quotaParts(-120)).toEqual({ hours: 0, minutes: 0 })
    expect(quotaParts(Number.NaN)).toEqual({ hours: 0, minutes: 0 })
  })
})

describe('passwordProblem', () => {
  it('checks every field before the API', () => {
    expect(passwordProblem('', 'newpassword1', 'newpassword1')).toBe('profile.password.currentRequired')
    expect(passwordProblem('old', 'short', 'short')).toBe('auth.validation.passwordShort')
    expect(passwordProblem('old', 'newpassword1', 'newpassword2')).toBe('profile.password.mismatch')
    expect(passwordProblem('samepassword', 'samepassword', 'samepassword')).toBe('profile.password.same')
    expect(passwordProblem('old', 'newpassword1', 'newpassword1')).toBeNull()
  })
})

describe('model values', () => {
  it('round-trips a provider/model pair; empty = system default', () => {
    expect(modelValue('gemini', 'gemini-2.5-flash')).toBe('gemini:gemini-2.5-flash')
    expect(modelValue(null, null)).toBe('')
    expect(parseModelValue('openai:gpt-4o')).toEqual({ provider: 'openai', model: 'gpt-4o' })
    expect(parseModelValue('')).toEqual({ provider: null, model: null })
    expect(parseModelValue('nocolon')).toEqual({ provider: null, model: null })
  })
})

describe('profileErrorKey', () => {
  const e = (status: number, code = 'x') => new ApiError(status, code, '')
  it('maps per form', () => {
    expect(profileErrorKey('details', e(409))).toBe('profile.errors.usernameTaken')
    expect(profileErrorKey('details', e(422))).toBe('profile.errors.invalid')
    expect(profileErrorKey('password', e(403, 'wrong_password'))).toBe('profile.errors.wrongPassword')
    expect(profileErrorKey('password', e(409))).toBe('profile.errors.passwordChanged')
    expect(profileErrorKey('password', e(422))).toBe('profile.errors.passwordRejected')
    expect(profileErrorKey('model', e(400))).toBe('profile.errors.modelNotAllowed')
    expect(profileErrorKey('password', e(429))).toBe('profile.errors.rateLimited')
    expect(profileErrorKey('details', e(0, 'network'))).toBe('profile.errors.network')
    expect(profileErrorKey('details', e(500))).toBe('profile.errors.generic')
    expect(profileErrorKey('details', new Error('x'))).toBe('profile.errors.generic')
  })
})
