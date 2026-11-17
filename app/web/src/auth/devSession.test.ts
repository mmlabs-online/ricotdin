import { describe, expect, it } from 'vitest'
import { devAuthState, fetchDevState } from './devSession'

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

describe('fetchDevState', () => {
  it('GETs <apiUrl>/auth/me without credentials or Authorization and maps the answer', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify(user), { status: 200 })
    }) as unknown as typeof fetch
    expect(await fetchDevState(fetchFn, 'http://localhost:5173/__dev_api')).toEqual({ status: 'signedIn', user })
    expect(calls[0]?.url).toBe('http://localhost:5173/__dev_api/auth/me')
    expect(calls[0]?.init?.credentials).toBe('omit')
    expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toBeNull()
  })

  it('a non-JSON answer (proxy error page) is unavailable', async () => {
    const fetchFn = (async () => new Response('<html>', { status: 500 })) as unknown as typeof fetch
    expect(await fetchDevState(fetchFn, 'http://localhost:5173/__dev_api')).toEqual({ status: 'unavailable' })
  })
})
