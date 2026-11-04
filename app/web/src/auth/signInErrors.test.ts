import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/errors'
import { signInErrorKey } from './signInErrors'

describe('signInErrorKey', () => {
  it('maps the API codes', () => {
    expect(signInErrorKey(new ApiError(401, 'invalid_credentials', ''))).toBe('auth.errors.invalid_credentials')
    expect(signInErrorKey(new ApiError(403, 'email_not_verified', ''))).toBe('auth.errors.email_not_verified')
    expect(signInErrorKey(new ApiError(403, 'account_disabled', ''))).toBe('auth.errors.account_disabled')
    expect(signInErrorKey(new ApiError(429, 'rate_limited', ''))).toBe('auth.errors.rate_limited')
    expect(signInErrorKey(new ApiError(0, 'network', ''))).toBe('auth.errors.network')
  })
  it('never shows unknown server text', () => {
    expect(signInErrorKey(new ApiError(500, 'internal', 'boom'))).toBe('auth.errors.generic')
    expect(signInErrorKey(new Error('x'))).toBe('auth.errors.generic')
  })
})
