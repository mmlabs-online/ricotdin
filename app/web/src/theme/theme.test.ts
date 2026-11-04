import { describe, expect, it } from 'vitest'
import { parseColorTheme, resolveDark, themeClasses } from './theme'

describe('theme', () => {
  it('parses stored palettes, defaulting to rose', () => {
    expect(parseColorTheme('ocean')).toBe('ocean')
    expect(parseColorTheme('neon')).toBe('rose')
    expect(parseColorTheme(null)).toBe('rose')
  })
  it('lets a stored choice override the system preference', () => {
    expect(resolveDark('1', false)).toBe(true)
    expect(resolveDark('0', true)).toBe(false)
    expect(resolveDark(null, true)).toBe(true)
  })
  it('builds the html classes', () => {
    expect(themeClasses('rose', false)).toEqual([])
    expect(themeClasses('sage', true)).toEqual(['theme-sage', 'dark'])
  })
})
