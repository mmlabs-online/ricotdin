import { describe, expect, it } from 'vitest'
import { AuthSession, type SessionDeps } from './session'

const user = { id: 'u1', email: 'a@b.c', username: 'alex', role: 'user' as const }
const tokenBody = (t: string) => ({ access_token: t, token_type: 'bearer', expires_in: 900, user })

type Call = { url: string; init: RequestInit | undefined }

function fakeDeps(answers: Array<() => Response>, clock = { t: 1_000_000 }) {
  const calls: Call[] = []
  const posted: unknown[] = []
  const channel = { onmessage: null as ((e: MessageEvent) => void) | null, postMessage: (m: unknown) => posted.push(m), close: () => {} }
  const deps: SessionDeps = {
    fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      const next = answers.shift()
      if (!next) throw new Error('unexpected fetch')
      return next()
    },
    now: () => clock.t,
    channel,
    locks: { request: (_name, cb) => cb() },
  }
  return { deps, calls, posted, channel, clock }
}

const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status })

describe('AuthSession', () => {
  it('restores the session from the refresh cookie and shares the token', async () => {
    const f = fakeDeps([json(200, tokenBody('t1'))])
    const s = new AuthSession('https://api.example.com', f.deps)
    await s.start()
    expect(s.getState()).toEqual({ status: 'signedIn', user })
    expect(s.accessToken).toBe('t1')
    expect(f.calls[0]?.url).toBe('https://api.example.com/auth/refresh')
    expect(f.calls[0]?.init?.credentials).toBe('include')
    expect(f.posted).toHaveLength(1)
  })

  it('is signed out when there is no session', async () => {
    const f = fakeDeps([json(401, { error: { code: 'unauthorized', message: '' } })])
    const s = new AuthSession('https://api.example.com', f.deps)
    await s.start()
    expect(s.getState()).toEqual({ status: 'signedOut' })
  })

  it('runs one refresh for concurrent callers', async () => {
    const f = fakeDeps([json(200, tokenBody('t1'))])
    const s = new AuthSession('https://api.example.com', f.deps)
    await Promise.all([s.refresh(), s.refresh(), s.refresh()])
    expect(f.calls).toHaveLength(1)
  })

  it('adopts a token another tab refreshed instead of calling the API', async () => {
    const f = fakeDeps([])
    const s = new AuthSession('https://api.example.com', f.deps)
    f.channel.onmessage?.({ data: { type: 'token', accessToken: 'other', expiresAt: f.clock.t + 900_000, user, at: f.clock.t } } as MessageEvent)
    expect(await s.refresh()).toBe(true)
    expect(s.accessToken).toBe('other')
    expect(f.calls).toHaveLength(0)
  })

  it('keeps the session when a 401 follows another tab rotating the cookie', async () => {
    const f = fakeDeps([json(200, tokenBody('t1')), json(401, {})])
    const s = new AuthSession('https://api.example.com', f.deps)
    await s.start()
    f.clock.t += 900_000 // our token expired
    f.channel.onmessage?.({ data: { type: 'token', accessToken: 't2', expiresAt: f.clock.t + 900_000, user, at: f.clock.t - 5_000 } } as MessageEvent)
    f.clock.t += 1
    // the shared token predates our refresh, so we still call the API; its 401 is the race
    expect(await s.refresh()).toBe(true)
    expect(s.accessToken).toBe('t2')
    expect(s.getState().status).toBe('signedIn')
  })

  it('signs out every tab on sign-out', async () => {
    const f = fakeDeps([json(200, tokenBody('t1')), () => new Response(null, { status: 204 })])
    const s = new AuthSession('https://api.example.com', f.deps)
    await s.start()
    expect(await s.signOut()).toBe(true)
    expect(s.getState()).toEqual({ status: 'signedOut' })
    expect(s.accessToken).toBeNull()
    expect(f.posted.at(-1)).toEqual({ type: 'signedOut' })
  })

  it('reports a sign-out the server did not confirm (the cookie may still be valid)', async () => {
    for (const answer of [json(500, {}), json(403, {}), () => { throw new TypeError('offline') }]) {
      const f = fakeDeps([json(200, tokenBody('t1')), answer])
      const s = new AuthSession('https://api.example.com', f.deps)
      await s.start()
      expect(await s.signOut()).toBe(false)
      expect(s.getState()).toEqual({ status: 'signedOut' }) // this browser forgets it anyway
    }
  })

  it('a refresh that was running when the user signed out cannot sign them back in', async () => {
    let release: (r: Response) => void = () => {}
    const pending = new Promise<Response>((resolve) => (release = resolve))
    const f = fakeDeps([json(200, tokenBody('t1')), () => pending as unknown as Response, () => new Response(null, { status: 204 })])
    // fakeDeps returns the thunk's value; make the second answer resolve later
    const s = new AuthSession('https://api.example.com', f.deps)
    await s.start()
    const refreshing = s.refresh()
    const out = s.signOut()
    release(new Response(JSON.stringify(tokenBody('t2')), { status: 200 }))
    await refreshing
    await out
    expect(s.getState()).toEqual({ status: 'signedOut' })
    expect(s.accessToken).toBeNull()
  })

  it('ignores a token another tab broadcast before we signed out', async () => {
    const f = fakeDeps([json(200, tokenBody('t1')), () => new Response(null, { status: 204 })])
    const s = new AuthSession('https://api.example.com', f.deps)
    await s.start()
    const old = { type: 'token', accessToken: 'late', expiresAt: f.clock.t + 900_000, user, at: f.clock.t - 1 }
    await s.signOut()
    f.channel.onmessage?.({ data: old } as MessageEvent)
    expect(s.getState()).toEqual({ status: 'signedOut' })
  })

  it('is "unavailable", not signed out, when the API cannot answer at start', async () => {
    for (const answer of [json(503, {}), json(429, {}), json(200, { nope: 1 }), () => { throw new TypeError('offline') }]) {
      const f = fakeDeps([answer])
      const s = new AuthSession('https://api.example.com', f.deps)
      await s.start()
      expect(s.getState()).toEqual({ status: 'unavailable' })
    }
  })

  it('a later transient refresh failure keeps the session', async () => {
    const f = fakeDeps([json(200, tokenBody('t1')), json(502, {})])
    const s = new AuthSession('https://api.example.com', f.deps)
    await s.start()
    await expect(s.refresh()).rejects.toBeTruthy()
    expect(s.getState().status).toBe('signedIn')
  })

  it('surfaces sign-in errors with the API code', async () => {
    const f = fakeDeps([json(403, { error: { code: 'email_not_verified', message: 'Verify.' } })])
    const s = new AuthSession('https://api.example.com', f.deps)
    await expect(s.signIn('a@b.c', 'pw')).rejects.toMatchObject({ code: 'email_not_verified', status: 403 })
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ identifier: 'a@b.c', password: 'pw' })
  })
})
