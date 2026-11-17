import { describe, expect, it } from 'vitest'
import { devAuthState } from './devSession'

const user = { id: 'u1', email: 'a@b.c', username: null, role: 'admin' }

describe('devAuthState', () => {
  it('200 with a valid user -> signedIn', () => {
    expect(devAuthState(200, user)).toEqual({ status: 'signedIn', user })
  })

  it('anything else -> unavailable (retry screen, never the sign-in page)', () => {
    expect(devAuthState(200, { id: 'u1' })).toEqual({ status: 'unavailable' })
    expect(devAuthState(200, null)).toEqual({ status: 'unavailable' })
    for (const status of [401, 403, 409, 500, 502]) {
      expect(devAuthState(status, user)).toEqual({ status: 'unavailable' })
    }
  })
})
