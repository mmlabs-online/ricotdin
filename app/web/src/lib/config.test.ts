import { describe, expect, it } from 'vitest'
import { ConfigError, parseRuntimeConfig } from './config'

describe('parseRuntimeConfig', () => {
  it('accepts https URLs and trims a trailing slash', () => {
    expect(parseRuntimeConfig({ apiUrl: 'https://api.example.com/' })).toEqual({
      apiUrl: 'https://api.example.com',
      authUrl: 'https://api.example.com',
    })
    expect(
      parseRuntimeConfig({ apiUrl: 'https://api.example.com', authUrl: 'https://auth.example.com' }),
    ).toEqual({ apiUrl: 'https://api.example.com', authUrl: 'https://auth.example.com' })
  })

  it('allows http only for localhost', () => {
    expect(parseRuntimeConfig({ apiUrl: 'http://localhost:8000' }).apiUrl).toBe('http://localhost:8000')
    expect(parseRuntimeConfig({ apiUrl: 'http://127.0.0.1:8000' }).apiUrl).toBe('http://127.0.0.1:8000')
    expect(() => parseRuntimeConfig({ apiUrl: 'http://api.example.com' })).toThrow(ConfigError)
    // same rule as deploy/15-ricotdin-config.envsh
    expect(() => parseRuntimeConfig({ apiUrl: 'http://[::1]:8000' })).toThrow(ConfigError)
  })

  it('rejects anything that is not an origin', () => {
    for (const apiUrl of [
      '',
      'api.example.com',
      'ftp://api.example.com',
      'https://api.example.com/v1', // the API is served at / (refresh cookie Path=/auth)
      'https://api.example.com?x=1',
      'https://api.example.com#x',
      'https://user:pw@api.example.com',
      'javascript:alert(1)',
    ]) {
      expect(() => parseRuntimeConfig({ apiUrl }), apiUrl).toThrow(ConfigError)
    }
    expect(() => parseRuntimeConfig({ apiUrl: 'https://a.example.com', authUrl: 'http://b.example.com' })).toThrow(
      ConfigError,
    )
  })

  it('rejects bodies that are not objects', () => {
    for (const raw of [null, undefined, 'x', 1, [], { apiUrl: 3 }]) {
      expect(() => parseRuntimeConfig(raw)).toThrow(ConfigError)
    }
  })
})
