import { describe, expect, it } from 'vitest'
import { parseAuthMessage, usableShared } from './broadcast'

const user = { id: 'u1', email: 'a@b.c', username: null, role: 'user' as const }

describe('parseAuthMessage', () => {
  it('accepts well-formed messages only', () => {
    expect(parseAuthMessage({ type: 'signedOut' })).toEqual({ type: 'signedOut' })
    const token = { type: 'token', accessToken: 't', expiresAt: 5, user, at: 1 }
    expect(parseAuthMessage(token)).toEqual(token)
    for (const bad of [null, 'x', { type: 'token' }, { ...token, user: { ...user, role: 'root' } }, { type: 'other' }]) {
      expect(parseAuthMessage(bad)).toBeNull()
    }
  })
})

describe('usableShared', () => {
  const msg = { type: 'token' as const, accessToken: 't', expiresAt: 1_000_000, user, at: 100 }
  it('uses a token another tab refreshed after we started waiting', () => {
    expect(usableShared(msg, 100, 200)).toBe(true)
  })
  it('ignores older or nearly expired tokens', () => {
    expect(usableShared(msg, 101, 200)).toBe(false)
    expect(usableShared({ ...msg, expiresAt: 210 }, 0, 200)).toBe(false)
    expect(usableShared(null, 0, 200)).toBe(false)
  })
})
