// Every literal t('…') key used in the code must resolve to a string in EN and VI (a key that
// points at an object renders an i18next error message instead of text).
import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import vi from './locales/vi.json'

const files = import.meta.glob(['../**/*.ts', '../**/*.tsx', '!../**/*.test.ts', '!../**/*.test.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function resolve(dict: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), dict)
}

function isText(dict: unknown, key: string): boolean {
  return typeof resolve(dict, key) === 'string' || typeof resolve(dict, `${key}_other`) === 'string'
}

describe('i18n keys used in code', () => {
  const keys = new Set<string>()
  for (const src of Object.values(files)) {
    for (const m of src.matchAll(/\bt\(\s*'([A-Za-z0-9_.]+)'/g)) keys.add(m[1]!)
    for (const m of src.matchAll(/Key(?:=|:)\s*['"]([a-z][A-Za-z0-9_]*\.[A-Za-z0-9_.]+)['"]/g)) keys.add(m[1]!)
  }
  it('finds the keys', () => {
    expect(keys.size).toBeGreaterThan(50)
  })
  for (const [lang, dict] of [['en', en], ['vi', vi]] as const) {
    it(`all resolve to text in ${lang}`, () => {
      const bad = [...keys].filter((k) => !isText(dict, k))
      expect(bad).toEqual([])
    })
  }
})
