import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/errors'
import { modelValue, parseModelValue, profileErrorKey, quotaParts } from './profile'

describe('quotaParts', () => {
  it('hours and minutes, never negative (the raw balance may be)', () => {
    expect(quotaParts(3 * 3600 + 25 * 60 + 59)).toEqual({ hours: 3, minutes: 25 })
    expect(quotaParts(59)).toEqual({ hours: 0, minutes: 0 })
    expect(quotaParts(-120)).toEqual({ hours: 0, minutes: 0 })
    expect(quotaParts(Number.NaN)).toEqual({ hours: 0, minutes: 0 })
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
    expect(profileErrorKey('model', e(400))).toBe('profile.errors.modelNotAllowed')
    expect(profileErrorKey('folder', e(404))).toBe('profile.errors.folderUnavailable')
    expect(profileErrorKey('folder', e(422))).toBe('profile.errors.folderUnavailable')
    expect(profileErrorKey('details', e(0, 'network'))).toBe('profile.errors.network')
    expect(profileErrorKey('details', e(500))).toBe('profile.errors.generic')
    expect(profileErrorKey('details', new Error('x'))).toBe('profile.errors.generic')
  })
})
