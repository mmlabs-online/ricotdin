import { describe, expect, it } from 'vitest'
import { initials } from './initials'

describe('initials', () => {
  it('uses two words of the username', () => {
    expect(initials({ username: 'alex.morgan', email: 'x@y.z' })).toBe('AM')
  })
  it('falls back to the email', () => {
    expect(initials({ username: null, email: 'tu@acme.com' })).toBe('TU')
    expect(initials({ username: '', email: 'b@acme.com' })).toBe('B')
  })
  it('is empty without a user', () => {
    expect(initials(null)).toBe('')
  })
})
