import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/errors'
import { publicAuthErrorKey } from './authErrors'

describe('publicAuthErrorKey (mmlabs, AUT-05)', () => {
  it('maps mmlabs answers to messages', () => {
    expect(publicAuthErrorKey(new ApiError(409, 'email_taken', 'x'), 'register')).toBe('auth.register.taken')
    expect(publicAuthErrorKey(new ApiError(422, 'weak_password', 'x'), 'register')).toBe('auth.errors.weak_password')
    expect(publicAuthErrorKey(new ApiError(422, 'weak_password', 'x'), 'reset')).toBe('auth.errors.weak_password')
    expect(publicAuthErrorKey(new ApiError(422, 'validation_error', 'x'), 'register')).toBe('auth.register.invalid')
    // a truncated link or a bad address is not a password problem
    expect(publicAuthErrorKey(new ApiError(422, 'validation_error', 'x'), 'verify')).toBe('auth.errors.invalidLink')
    expect(publicAuthErrorKey(new ApiError(422, 'validation_error', 'x'), 'reset')).toBe('auth.register.invalid')
    expect(publicAuthErrorKey(new ApiError(422, 'token_invalid', 'x'), 'verify')).toBe('auth.errors.invalidLink')
    expect(publicAuthErrorKey(new ApiError(422, 'token_invalid', 'x'), 'reset')).toBe('auth.errors.invalidLink')
    expect(publicAuthErrorKey(new ApiError(403, 'turnstile_failed', 'x'), 'register')).toBe('auth.errors.turnstile_failed')
    expect(publicAuthErrorKey(new ApiError(429, 'rate_limited', 'x'), 'reset')).toBe('auth.errors.rate_limited')
    expect(publicAuthErrorKey(new ApiError(503, 'unavailable', 'x'), 'register')).toBe('auth.errors.unavailable')
    expect(publicAuthErrorKey(new ApiError(0, 'network', ''), 'register')).toBe('auth.errors.network')
    expect(publicAuthErrorKey(new Error('x'), 'reset')).toBe('auth.errors.generic')
  })
})
