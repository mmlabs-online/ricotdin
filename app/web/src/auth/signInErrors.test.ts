import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/errors'
import { needsTurnstile, signInErrorKey } from './signInErrors'

describe('signInErrorKey', () => {
  it('maps the mmlabs and ricotdin codes', () => {
    expect(signInErrorKey(new ApiError(401, 'invalid_credentials', ''))).toBe('auth.errors.invalid_credentials')
    expect(signInErrorKey(new ApiError(403, 'account_disabled', ''))).toBe('auth.errors.account_disabled')
    expect(signInErrorKey(new ApiError(409, 'account_link_conflict', ''))).toBe('auth.errors.account_link_conflict')
    expect(signInErrorKey(new ApiError(403, 'turnstile_required', ''))).toBe('auth.errors.turnstile_required')
    expect(signInErrorKey(new ApiError(403, 'turnstile_failed', ''))).toBe('auth.errors.turnstile_failed')
    expect(signInErrorKey(new ApiError(429, 'rate_limited', ''))).toBe('auth.errors.rate_limited')
    expect(signInErrorKey(new ApiError(0, 'network', ''))).toBe('auth.errors.network')
  })
  it('never shows unknown server text', () => {
    expect(signInErrorKey(new ApiError(500, 'internal', 'boom'))).toBe('auth.errors.generic')
    expect(signInErrorKey(new Error('x'))).toBe('auth.errors.generic')
  })
  it('asks for the Turnstile challenge only when mmlabs does', () => {
    expect(needsTurnstile(new ApiError(403, 'turnstile_required', ''))).toBe(true)
    expect(needsTurnstile(new ApiError(403, 'turnstile_failed', ''))).toBe(true)
    expect(needsTurnstile(new ApiError(401, 'invalid_credentials', ''))).toBe(false)
    expect(needsTurnstile(new Error('x'))).toBe(false)
  })
})
