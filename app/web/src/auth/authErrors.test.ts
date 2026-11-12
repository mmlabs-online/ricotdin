import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/errors'
import { publicAuthErrorKey } from './authErrors'

describe('publicAuthErrorKey', () => {
  it('maps API answers to messages', () => {
    expect(publicAuthErrorKey(new ApiError(409, 'conflict', 'x'), 'register')).toBe('auth.register.taken')
    expect(publicAuthErrorKey(new ApiError(422, 'unprocessable', 'x'), 'register')).toBe('auth.register.invalid')
    expect(publicAuthErrorKey(new ApiError(400, 'invalid_token', 'x'), 'verify')).toBe('auth.errors.invalidLink')
    expect(publicAuthErrorKey(new ApiError(429, 'rate_limited', 'x'), 'reset')).toBe('auth.errors.rate_limited')
    expect(publicAuthErrorKey(new ApiError(503, 'unavailable', 'x'), 'register')).toBe('auth.errors.unavailable')
    expect(publicAuthErrorKey(new ApiError(0, 'network', ''), 'register')).toBe('auth.errors.network')
    expect(publicAuthErrorKey(new Error('x'), 'reset')).toBe('auth.errors.generic')
  })
})
