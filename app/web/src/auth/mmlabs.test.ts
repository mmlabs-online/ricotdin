import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/errors'
import { MM_APP, actionFor, parseAccounts, parseTokenBody } from './mmlabs'

describe('mmlabs helpers (AUT-05)', () => {
  it('the app key is ricotdin', () => {
    expect(MM_APP).toBe('ricotdin')
  })

  it('maps /token refusals to what the user must do', () => {
    expect(actionFor(401, 'session_invalid', undefined)).toBe('signedOut')
    expect(actionFor(403, 'not_member', { join_available: true })).toBe('join')
    expect(actionFor(403, 'not_member', { join_available: false })).toBe('joinClosed')
    expect(actionFor(403, 'not_member', null)).toBe('joinClosed')
    expect(actionFor(403, 'email_unverified', null)).toBe('verify')
    expect(actionFor(403, 'origin_not_allowed', null)).toBe('error')
    expect(actionFor(429, 'rate_limited', null)).toBe('error')
    expect(actionFor(500, 'http_500', null)).toBe('error')
  })

  it('reads a token answer and refuses anything else', () => {
    expect(parseTokenBody({ access_token: 'x', token_type: 'Bearer', expires_in: 900, audience: 'ricotdin' })).toEqual({
      accessToken: 'x',
      expiresIn: 900,
    })
    expect(parseTokenBody({ access_token: 'x', expires_in: 900, audience: 'admin' })).toBeNull()
    expect(parseTokenBody({ access_token: '', expires_in: 900, audience: 'ricotdin' })).toBeNull()
    expect(parseTokenBody({ access_token: 'x', expires_in: '900', audience: 'ricotdin' })).toBeNull()
    expect(parseTokenBody(null)).toBeNull()
  })

  it('reads the accounts signed in on this browser', () => {
    const body = {
      items: [
        { account_id: 'a1', email: 'a@x.com', email_verified: true, display_name: null },
        { account_id: 7, email: 'bad' },
        { account_id: 'a2', email: 'b@x.com', email_verified: false, display_name: 'Bee' },
      ],
    }
    expect(parseAccounts(body)).toEqual([
      { accountId: 'a1', email: 'a@x.com', emailVerified: true },
      { accountId: 'a2', email: 'b@x.com', emailVerified: false },
    ])
    expect(parseAccounts({})).toEqual([])
    expect(parseAccounts('nope')).toEqual([])
  })

  it('keeps ApiError details for the join decision', () => {
    const err = new ApiError(403, 'not_member', '', { join_available: true })
    expect(err.details).toEqual({ join_available: true })
  })
})
