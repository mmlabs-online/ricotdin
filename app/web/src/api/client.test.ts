import { describe, expect, it } from 'vitest'
import type { AuthSession } from '../auth/session'
import { authFetch } from './client'

function fakeSession(tokens: string[], refreshOk = true) {
  let current = tokens[0] ?? null
  let refreshes = 0
  const session = {
    getToken: async () => current,
    refresh: async () => {
      refreshes += 1
      current = tokens[refreshes] ?? null
      return refreshOk
    },
    get accessToken() {
      return current
    },
  } as unknown as AuthSession
  return { session, refreshes: () => refreshes }
}

function recorder(statuses: number[]) {
  const seen: Array<{ url: string; auth: string | null; body: string }> = []
  const fetchFn = (async (req: Request) => {
    seen.push({ url: req.url, auth: req.headers.get('Authorization'), body: await req.text() })
    return new Response(null, { status: statuses.shift() ?? 200 })
  }) as unknown as typeof fetch
  return { seen, fetchFn }
}

const API = 'https://api.example.com'

describe('authFetch', () => {
  it('adds the bearer token for the API origin', async () => {
    const { session } = fakeSession(['t1'])
    const r = recorder([200])
    await authFetch(session, API, r.fetchFn)(new Request(`${API}/meetings`))
    expect(r.seen[0]?.auth).toBe('Bearer t1')
  })

  it('never sends the token to another origin', async () => {
    const { session, refreshes } = fakeSession(['t1'])
    const r = recorder([401])
    const res = await authFetch(session, API, r.fetchFn)(new Request('https://www.googleapis.com/upload/x'))
    expect(r.seen[0]?.auth).toBeNull()
    expect(res.status).toBe(401)
    expect(refreshes()).toBe(0)
  })

  it('refreshes once after a 401 and retries with the body intact', async () => {
    const { session, refreshes } = fakeSession(['old', 'new'])
    const r = recorder([401, 200])
    const res = await authFetch(session, API, r.fetchFn)(
      new Request(`${API}/chat`, { method: 'POST', body: '{"message":"hi"}' }),
    )
    expect(res.status).toBe(200)
    expect(refreshes()).toBe(1)
    expect(r.seen.map((s) => s.auth)).toEqual(['Bearer old', 'Bearer new'])
    expect(r.seen[1]?.body).toBe('{"message":"hi"}')
  })

  it('returns the 401 when the session is gone', async () => {
    const { session } = fakeSession(['old'], false)
    const r = recorder([401])
    expect((await authFetch(session, API, r.fetchFn)(new Request(`${API}/meetings`))).status).toBe(401)
    expect(r.seen).toHaveLength(1)
  })
})
