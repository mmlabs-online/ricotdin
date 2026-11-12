import { describe, expect, it } from 'vitest'
import { REFRESH_SKEW_MS, expiresAtFrom, isExpiringSoon } from './token'

describe('isExpiringSoon', () => {
  const now = 1_000_000
  it('is false well before expiry', () => {
    expect(isExpiringSoon(now + REFRESH_SKEW_MS + 1, now)).toBe(false)
  })
  it('is true inside the skew window and after expiry', () => {
    expect(isExpiringSoon(now + REFRESH_SKEW_MS, now)).toBe(true)
    expect(isExpiringSoon(now - 1, now)).toBe(true)
  })
  it('treats a missing or broken expiry as expired', () => {
    expect(isExpiringSoon(null, now)).toBe(true)
    expect(isExpiringSoon(Number.NaN, now)).toBe(true)
  })
})

describe('expiresAtFrom', () => {
  it('turns expires_in seconds into an absolute time', () => {
    expect(expiresAtFrom(900, 1000)).toBe(901_000)
  })
  it('clamps nonsense to "already expired"', () => {
    expect(expiresAtFrom(-5, 1000)).toBe(1000)
    expect(expiresAtFrom(Number.NaN, 1000)).toBe(1000)
    expect(expiresAtFrom(10 ** 9, 1000)).toBe(1000 + 24 * 3600 * 1000) // never more than a day
  })
})
