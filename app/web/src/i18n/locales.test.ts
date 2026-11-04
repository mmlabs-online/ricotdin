import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import vi from './locales/vi.json'

function keys(obj: object, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  )
}

describe('locale files', () => {
  it('EN and VI have the same keys', () => {
    expect(keys(vi).sort()).toEqual(keys(en).sort())
  })
  it('no empty strings', () => {
    const values = (o: object): unknown[] => Object.values(o).flatMap((v) => (typeof v === 'object' && v ? values(v) : [v]))
    for (const v of [...values(en), ...values(vi)]) expect(typeof v === 'string' && v.trim().length > 0).toBe(true)
  })
})
