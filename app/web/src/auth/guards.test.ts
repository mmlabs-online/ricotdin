import { describe, expect, it } from 'vitest'
import { guardDecision, safeReturnTo, signInPath } from './guards'

describe('guardDecision', () => {
  it('waits while the session is being restored', () => {
    expect(guardDecision({ status: 'loading' }, 'user')).toBe('wait')
  })
  it('sends signed-out visitors to sign-in', () => {
    expect(guardDecision({ status: 'signedOut' }, 'user')).toBe('signIn')
    expect(guardDecision({ status: 'signedOut' }, 'admin')).toBe('signIn')
  })
  it('lets users into user routes but not admin routes', () => {
    expect(guardDecision({ status: 'signedIn', role: 'user' }, 'user')).toBe('allow')
    expect(guardDecision({ status: 'signedIn', role: 'user' }, 'admin')).toBe('forbidden')
    expect(guardDecision({ status: 'signedIn', role: 'admin' }, 'admin')).toBe('allow')
  })
})

describe('safeReturnTo', () => {
  it('keeps same-app paths with their query', () => {
    expect(safeReturnTo('/meetings/abc?tab=notes')).toBe('/meetings/abc?tab=notes')
  })
  it('drops the fragment (email-link tokens live there and must never reach a URL query)', () => {
    expect(safeReturnTo('/reset-password#token=abc')).toBe('/reset-password')
    expect(safeReturnTo('/meetings/abc?x=1#t=12')).toBe('/meetings/abc?x=1')
  })
  it('refuses anything that could leave the app', () => {
    for (const raw of [null, '', 'meetings', '//evil.com', '/\\evil.com', 'https://evil.com', '/sign-in', '/sign-in?next=/x', ' /x', '/x\n']) {
      expect(safeReturnTo(raw), String(raw)).toBe('/meetings')
    }
  })
})

describe('signInPath', () => {
  it('encodes the place to return to, without the fragment', () => {
    expect(signInPath('/meetings/a b', '?x=1')).toBe('/sign-in?next=%2Fmeetings%2Fa%20b%3Fx%3D1')
  })
  it('omits next for the default page', () => {
    expect(signInPath('/', '')).toBe('/sign-in')
  })
})
