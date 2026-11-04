import { describe, expect, it } from 'vitest'
import { resolveLocale } from './locale'

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
