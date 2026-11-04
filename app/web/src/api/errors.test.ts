import { describe, expect, it } from 'vitest'
import { ApiError, apiErrorFrom } from './errors'

describe('apiErrorFrom', () => {
  it('reads the v2 error envelope', () => {
    const err = apiErrorFrom(401, { error: { code: 'invalid_credentials', message: 'Invalid login.' } })
    expect(err).toBeInstanceOf(ApiError)
    expect([err.status, err.code, err.message]).toEqual([401, 'invalid_credentials', 'Invalid login.'])
  })
  it('falls back to a status-based code for anything else', () => {
    expect(apiErrorFrom(500, 'oops').code).toBe('http_500')
    expect(apiErrorFrom(429, { error: { code: 7 } }).code).toBe('http_429')
    expect(apiErrorFrom(0, null).code).toBe('network')
  })
  it('bounds the server message', () => {
    expect(apiErrorFrom(400, { error: { code: 'x', message: 'm'.repeat(5000) } }).message.length).toBe(500)
  })
})
