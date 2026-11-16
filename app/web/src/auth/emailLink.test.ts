import { describe, expect, it } from 'vitest'
import { readHashToken } from './emailLink'

describe('readHashToken (verify / reset links carry #token=…; mmlabs tokens are 32–128 chars)', () => {
  it('reads a token from the fragment', () => {
    expect(readHashToken('#token=abcDEF123_-abcDEF123abcDEF123_-abcDEF123')).toBe('abcDEF123_-abcDEF123abcDEF123_-abcDEF123')
    expect(readHashToken('#x=1&token=abcDEF123_-abcDEF123abcDEF123_-abcDEF123')).toBe('abcDEF123_-abcDEF123abcDEF123_-abcDEF123')
  })
  it('refuses missing or malformed tokens', () => {
    for (const h of ['', '#', '#token=', '#token=short', '#token=has space here 123456', `#token=${'a'.repeat(129)}`, `#token=${'a'.repeat(31)}`, '#token=<script>alert(1)</script>']) {
      expect(readHashToken(h), h).toBeNull()
    }
  })
})
