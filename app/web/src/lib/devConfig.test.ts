import { describe, expect, it } from 'vitest'
import { parseRuntimeConfig } from './config'
import { withDevProxy } from './devConfig'

const base = parseRuntimeConfig({ apiUrl: 'http://localhost:5173' })

describe('withDevProxy', () => {
  it('moves apiUrl under the dev prefix and marks the config when devProxy is exactly /__dev_api', () => {
    expect(withDevProxy({ apiUrl: 'http://localhost:5173', devProxy: '/__dev_api' }, base)).toEqual({
      ...base,
      apiUrl: 'http://localhost:5173/__dev_api',
      devProxy: true,
    })
  })

  it('leaves the config alone otherwise', () => {
    for (const raw of [{}, { devProxy: true }, { devProxy: '/other' }, { devProxy: '/__dev_api/' }, null, 'x']) {
      expect(withDevProxy(raw, base)).toBe(base)
    }
  })

  it('production parsing is unchanged: an apiUrl with a path is still rejected', () => {
    expect(() => parseRuntimeConfig({ apiUrl: 'http://localhost:5173/__dev_api' })).toThrow()
  })
})
