import { describe, expect, it } from 'vitest'
import { accountLocaleToApply, resolveLocale } from './locale'

describe('accountLocaleToApply (PRF-06)', () => {
  it('switches to the account language when it differs from this device', () => {
    expect(accountLocaleToApply('vi', 'en')).toBe('vi')
    expect(accountLocaleToApply('en', 'vi')).toBe('en')
  })
  it('does nothing when it is the same', () => {
    expect(accountLocaleToApply('vi', 'vi')).toBeNull()
  })
  it('keeps the device language when the account has none or an unknown one', () => {
    for (const v of [null, undefined, '', 'fr', 'VI', 1, {}]) expect(accountLocaleToApply(v, 'en')).toBeNull()
  })
})

describe('resolveLocale', () => {
  it('prefers a valid stored choice', () => {
    expect(resolveLocale('vi', ['en-US'])).toBe('vi')
    expect(resolveLocale('en', ['vi-VN'])).toBe('en')
  })
  it('falls back to the first supported browser language', () => {
    expect(resolveLocale(null, ['fr-FR', 'vi-VN', 'en'])).toBe('vi')
    expect(resolveLocale('xx', ['EN-gb'])).toBe('en')
  })
  it('defaults to English', () => {
    expect(resolveLocale(undefined, [])).toBe('en')
    expect(resolveLocale(null, ['de'])).toBe('en')
  })
})
