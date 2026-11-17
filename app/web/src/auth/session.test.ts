import { describe, expect, it } from 'vitest'
import { AuthSession, type SessionDeps } from './session'

// AUT-05: the session lives at mmlabs (device cookie on api.mmlabs.online); ricotdin's API only
// receives the per-app access token and answers /auth/me with the ricotdin user.
const AUTH = 'https://auth.example.com'
const API = 'https://api.example.com'
const ACC1 = '11111111-1111-4111-8111-111111111111'
const user = { id: 'u1', email: 'a@b.c', username: 'alex', role: 'user' as const }
const tokenBody = (t: string) => ({ access_token: t, token_type: 'Bearer', expires_in: 900, audience: 'ricotdin' })

type Call = { url: string; init: RequestInit | undefined }

function fakeDeps(answers: Array<() => Response>, clock = { t: 1_000_000 }, account: string | null = ACC1) {
  const calls: Call[] = []
  const posted: unknown[] = []
  const store = { value: account }
  const channel = { onmessage: null as ((e: MessageEvent) => void) | null, postMessage: (m: unknown) => posted.push(m), close: () => {} }
  const deps: SessionDeps = {
    fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      const next = answers.shift()
      if (!next) throw new Error(`unexpected fetch ${String(url)}`)
      return next()
    },
    now: () => clock.t,
    channel,
    locks: { request: (_name, cb) => cb() },
    account: { get: () => store.value, set: (v) => (store.value = v), clear: () => (store.value = null) },
  }
  return { deps, calls, posted, channel, clock, store }
}

const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status })
const err = (status: number, code: string, details: unknown = null) => json(status, { error: { code, message: '', details } })
const signedIn = (t = 't1') => [json(200, tokenBody(t)), json(200, user)]
const body = (c: Call | undefined) => JSON.parse(String(c?.init?.body)) as unknown
const header = (c: Call | undefined, name: string) => new Headers(c?.init?.headers).get(name)

describe('AuthSession (mmlabs)', () => {
  it('gets a ricotdin token from mmlabs, then the ricotdin user, and shares it', async () => {
    const f = fakeDeps(signedIn())
    const s = new AuthSession(AUTH, API, f.deps)
    await s.start()
    expect(s.getState()).toEqual({ status: 'signedIn', user })
    expect(s.accessToken).toBe('t1')
    expect(f.calls[0]?.url).toBe(`${AUTH}/api/v1/auth/token`)
    expect(f.calls[0]?.init?.credentials).toBe('include')
    expect(header(f.calls[0], 'X-MM-App')).toBe('ricotdin')
    expect(body(f.calls[0])).toEqual({ audience: 'ricotdin', account_id: ACC1 })
    expect(f.calls[1]?.url).toBe(`${API}/auth/me`)
    expect(f.calls[1]?.init?.credentials).toBe('omit')
    expect(header(f.calls[1], 'Authorization')).toBe('Bearer t1')
    expect(f.posted).toHaveLength(1)
  })

  it('is signed out without a chosen account (no call at all)', async () => {
    const f = fakeDeps([], undefined, null)
    const s = new AuthSession(AUTH, API, f.deps)
    await s.start()
    expect(s.getState()).toEqual({ status: 'signedOut' })
    expect(f.calls).toHaveLength(0)
  })

  it('forgets the account when mmlabs says the session is gone', async () => {
    const f = fakeDeps([err(401, 'session_invalid')])
    const s = new AuthSession(AUTH, API, f.deps)
    await s.start()
    expect(s.getState()).toEqual({ status: 'signedOut' })
    expect(f.store.value).toBeNull()
  })

  it('asks to join when the account is not a member yet', async () => {
    const accounts = { items: [{ account_id: ACC1, email: 'a@b.c', email_verified: true, display_name: null }] }
    const f = fakeDeps([err(403, 'not_member', { join_available: true }), json(200, accounts)])
    const s = new AuthSession(AUTH, API, f.deps)
    await s.start()
    expect(s.getState()).toEqual({ status: 'actionRequired', action: 'join', accountId: ACC1, email: 'a@b.c' })
    expect(s.accessToken).toBeNull()
  })

  it('asks to verify the email first', async () => {
    const accounts = { items: [{ account_id: ACC1, email: 'a@b.c', email_verified: false, display_name: null }] }
    const f = fakeDeps([err(403, 'email_unverified'), json(200, accounts)])
    const s = new AuthSession(AUTH, API, f.deps)
    await s.start()
    expect(s.getState()).toMatchObject({ status: 'actionRequired', action: 'verify', email: 'a@b.c' })
  })

  it('joins on the user’s click, then signs in', async () => {
    const accounts = { items: [{ account_id: ACC1, email: 'a@b.c', email_verified: true, display_name: null }] }
    const f = fakeDeps([err(403, 'not_member', { join_available: true }), json(200, accounts), json(200, { status: 'member' }), ...signedIn()])
    const s = new AuthSession(AUTH, API, f.deps)
    await s.start()
    await s.join()
    expect(f.calls[2]?.url).toBe(`${AUTH}/api/v1/auth/apps/ricotdin/join`)
    expect(body(f.calls[2])).toEqual({ account_id: ACC1 })
    expect(s.getState()).toEqual({ status: 'signedIn', user })
  })

  it('signs in with email + password and remembers the account', async () => {
    const f = fakeDeps([json(200, { account_id: '99999999-9999-4999-8999-999999999999', user: { id: 'm1', email: 'a@b.c', email_verified: true } }), ...signedIn()], undefined, null)
    const s = new AuthSession(AUTH, API, f.deps)
    await s.signIn('a@b.c', 'pw', 'ts-token')
    expect(f.calls[0]?.url).toBe(`${AUTH}/api/v1/auth/login`)
    expect(body(f.calls[0])).toEqual({ email: 'a@b.c', password: 'pw', turnstile_token: 'ts-token' })
    expect(f.store.value).toBe('99999999-9999-4999-8999-999999999999')
    expect(body(f.calls[1])).toEqual({ audience: 'ricotdin', account_id: '99999999-9999-4999-8999-999999999999' })
    expect(s.getState()).toEqual({ status: 'signedIn', user })
  })

  it('surfaces sign-in errors with the mmlabs code', async () => {
    const f = fakeDeps([err(403, 'turnstile_required')], undefined, null)
    const s = new AuthSession(AUTH, API, f.deps)
    await expect(s.signIn('a@b.c', 'pw')).rejects.toMatchObject({ code: 'turnstile_required', status: 403 })
    expect(body(f.calls[0])).toEqual({ email: 'a@b.c', password: 'pw' })
  })

  it('a ricotdin refusal (disabled account) signs out and is reported', async () => {
    const f = fakeDeps([json(200, tokenBody('t1')), err(403, 'account_disabled')])
    const s = new AuthSession(AUTH, API, f.deps)
    await expect(s.refresh()).rejects.toMatchObject({ code: 'account_disabled' })
    expect(s.getState()).toEqual({ status: 'signedOut' })
    expect(s.accessToken).toBeNull()
  })

  it('continues as another account signed in on this browser', async () => {
    const f = fakeDeps(signedIn(), undefined, null)
    const s = new AuthSession(AUTH, API, f.deps)
    await s.continueAs('22222222-2222-4222-8222-222222222222')
    expect(f.store.value).toBe('22222222-2222-4222-8222-222222222222')
    expect(body(f.calls[0])).toEqual({ audience: 'ricotdin', account_id: '22222222-2222-4222-8222-222222222222' })
  })

  it('lists the accounts signed in on this browser', async () => {
    const f = fakeDeps([json(200, { items: [{ account_id: 'a1', email: 'x@y.z', email_verified: true, display_name: null }] })])
    const s = new AuthSession(AUTH, API, f.deps)
    expect(await s.accounts()).toEqual([{ accountId: 'a1', email: 'x@y.z', emailVerified: true }])
    expect(f.calls[0]?.url).toBe(`${AUTH}/api/v1/auth/accounts`)
    expect(f.calls[0]?.init?.method).toBe('GET')
  })

  it('a failed account listing is just an empty list', async () => {
    const f = fakeDeps([err(401, 'session_invalid')])
    expect(await new AuthSession(AUTH, API, f.deps).accounts()).toEqual([])
  })

  it('runs one refresh for concurrent callers', async () => {
    const f = fakeDeps(signedIn())
    const s = new AuthSession(AUTH, API, f.deps)
    await Promise.all([s.refresh(), s.refresh(), s.refresh()])
    expect(f.calls).toHaveLength(2)
  })

  it('adopts a token another tab got instead of calling mmlabs', async () => {
    const f = fakeDeps([])
    const s = new AuthSession(AUTH, API, f.deps)
    f.channel.onmessage?.({ data: { type: 'token', accessToken: 'other', expiresAt: f.clock.t + 900_000, user, at: f.clock.t } } as MessageEvent)
    expect(await s.refresh()).toBe(true)
    expect(s.accessToken).toBe('other')
    expect(f.calls).toHaveLength(0)
  })

  it('renews the token shortly before it expires', async () => {
    const f = fakeDeps([...signedIn('t1'), ...signedIn('t2')])
    const s = new AuthSession(AUTH, API, f.deps)
    await s.start()
    f.clock.t += 841_000 // 59 s left: within the renewal margin
    expect(await s.getToken()).toBe('t2')
  })

  it('signs out this account at mmlabs and in every tab', async () => {
    const f = fakeDeps([...signedIn(), () => new Response(null, { status: 204 })])
    const s = new AuthSession(AUTH, API, f.deps)
    await s.start()
    expect(await s.signOut()).toBe(true)
    expect(f.calls[2]?.url).toBe(`${AUTH}/api/v1/auth/logout`)
    expect(body(f.calls[2])).toEqual({ account_id: ACC1 })
    expect(s.getState()).toEqual({ status: 'signedOut' })
    expect(f.store.value).toBeNull()
    expect(f.posted.at(-1)).toEqual({ type: 'signedOut' })
  })

  it('reports a sign-out mmlabs did not confirm', async () => {
    for (const answer of [json(500, {}), () => { throw new TypeError('offline') }]) {
      const f = fakeDeps([...signedIn(), answer])
      const s = new AuthSession(AUTH, API, f.deps)
      await s.start()
      expect(await s.signOut()).toBe(false)
      expect(s.getState()).toEqual({ status: 'signedOut' })
    }
  })

  it('a refresh running when the user signed out cannot sign them back in', async () => {
    let release: (r: Response) => void = () => {}
    const pending = new Promise<Response>((resolve) => (release = resolve))
    const f = fakeDeps([...signedIn(), () => pending as unknown as Response, () => new Response(null, { status: 204 })])
    const s = new AuthSession(AUTH, API, f.deps)
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
    const f = fakeDeps([...signedIn(), () => new Response(null, { status: 204 })])
    const s = new AuthSession(AUTH, API, f.deps)
    await s.start()
    const old = { type: 'token', accessToken: 'late', expiresAt: f.clock.t + 900_000, user, at: f.clock.t - 1 }
    await s.signOut()
    f.channel.onmessage?.({ data: old } as MessageEvent)
    expect(s.getState()).toEqual({ status: 'signedOut' })
  })

  it('is "unavailable", not signed out, when mmlabs or the API cannot answer at start', async () => {
    for (const answers of [[json(503, {})], [json(429, {})], [json(200, { nope: 1 })], [() => { throw new TypeError('offline') }], [json(200, tokenBody('t')), json(502, {})]]) {
      const f = fakeDeps(answers)
      const s = new AuthSession(AUTH, API, f.deps)
      await s.start()
      expect(s.getState()).toEqual({ status: 'unavailable' })
      expect(f.store.value).toBe(ACC1) // a transient failure keeps the chosen account
    }
  })

  it('a later transient failure keeps the session', async () => {
    const f = fakeDeps([...signedIn(), json(502, {})])
    const s = new AuthSession(AUTH, API, f.deps)
    await s.start()
    await expect(s.refresh()).rejects.toBeTruthy()
    expect(s.getState().status).toBe('signedIn')
  })

  it('posts signed-out calls (sign-up, verify, reset) to mmlabs with the app header', async () => {
    const f = fakeDeps([json(201, { id: 'm1', email: 'a@b.co', email_verified: false }), err(422, 'token_invalid')])
    const s = new AuthSession(AUTH, API, f.deps)
    expect(await s.publicAuth('/signup', { email: 'a@b.co' })).toMatchObject({ id: 'm1' })
    expect(f.calls[0]?.url).toBe(`${AUTH}/api/v1/auth/signup`)
    expect(f.calls[0]?.init?.credentials).toBe('include')
    expect(header(f.calls[0], 'X-MM-App')).toBe('ricotdin')
    await expect(s.publicAuth('/verify-email', { token: 'x' })).rejects.toMatchObject({ code: 'token_invalid', status: 422 })
  })

  it('resends the verification email for the chosen account', async () => {
    const f = fakeDeps([() => new Response(null, { status: 202 })])
    const s = new AuthSession(AUTH, API, f.deps)
    await s.resendVerification()
    expect(f.calls[0]?.url).toBe(`${AUTH}/api/v1/auth/verify-email/resend`)
    expect(body(f.calls[0])).toEqual({ account_id: ACC1 })
  })

  it('joins the account shown on screen, even if another tab switched accounts meanwhile', async () => {
    const accounts = { items: [{ account_id: ACC1, email: 'a@b.c', email_verified: true, display_name: null }] }
    const f = fakeDeps([err(403, 'not_member', { join_available: true }), json(200, accounts), json(200, { status: 'member' }), ...signedIn()])
    const s = new AuthSession(AUTH, API, f.deps)
    await s.start()
    f.store.value = '33333333-3333-4333-8333-333333333333' // another tab chose another account
    await s.join()
    expect(body(f.calls[2])).toEqual({ account_id: ACC1 })
    expect(f.store.value).toBe(ACC1)
  })

  it('a resend for an already verified email just continues', async () => {
    const accounts = { items: [{ account_id: ACC1, email: 'a@b.c', email_verified: false, display_name: null }] }
    const f = fakeDeps([err(403, 'email_unverified'), json(200, accounts), err(409, 'email_already_verified'), ...signedIn()])
    const s = new AuthSession(AUTH, API, f.deps)
    await s.start()
    await s.resendVerification()
    expect(s.getState()).toEqual({ status: 'signedIn', user })
  })

  it('a sign-out in another tab while this tab waits on an action cannot be undone by its refresh', async () => {
    const accounts = { items: [{ account_id: ACC1, email: 'a@b.c', email_verified: true, display_name: null }] }
    let release: (r: Response) => void = () => {}
    const pending = new Promise<Response>((resolve) => (release = resolve))
    const f = fakeDeps([err(403, 'not_member', { join_available: true }), json(200, accounts), json(200, { status: 'member' }), () => pending as unknown as Response])
    const s = new AuthSession(AUTH, API, f.deps)
    await s.start()
    const joining = s.join()
    await new Promise((r) => setTimeout(r, 0))
    f.channel.onmessage?.({ data: { type: 'signedOut' } } as MessageEvent)
    release(new Response(JSON.stringify(tokenBody('late')), { status: 200 }))
    await joining.catch(() => undefined)
    expect(s.getState()).toEqual({ status: 'signedOut' })
    expect(s.accessToken).toBeNull()
  })

  it('ignores a corrupted account id instead of failing every start', async () => {
    const f = fakeDeps([], undefined, 'not a uuid at all <script>')
    const s = new AuthSession(AUTH, API, f.deps)
    await s.start()
    expect(s.getState()).toEqual({ status: 'signedOut' })
    expect(f.calls).toHaveLength(0)
  })
})

describe('AuthSession (dev proxy, OPS-08)', () => {
  const DEV_API = 'http://localhost:5173/__dev_api'
  const devDeps = (answers: Array<() => Response>) => {
    const f = fakeDeps(answers, undefined, null)
    return { ...f, deps: { ...f.deps, devProxy: true } }
  }

  it('asks only the API for /auth/me, without a token (the dev server adds it), and is signed in', async () => {
    const f = devDeps([json(200, user)])
    const s = new AuthSession(DEV_API, DEV_API, f.deps)
    await s.start()
    expect(s.getState()).toEqual({ status: 'signedIn', user })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]?.url).toBe(`${DEV_API}/auth/me`)
    expect(header(f.calls[0], 'Authorization')).toBeNull()
    expect(await s.getToken()).toBeNull()
    expect(f.calls).toHaveLength(1) // no renewal per request
  })

  it('a missing or expired dev token (401) shows the retry screen; retry signs in', async () => {
    const f = devDeps([err(401, 'unauthorized'), json(200, user)])
    const s = new AuthSession(DEV_API, DEV_API, f.deps)
    await s.start()
    expect(s.getState()).toEqual({ status: 'unavailable' })
    await s.start()
    expect(s.getState()).toEqual({ status: 'signedIn', user })
  })

  it('the API being down is unavailable, not signed out', async () => {
    const f = devDeps([() => { throw new TypeError('network') }])
    const s = new AuthSession(DEV_API, DEV_API, f.deps)
    await s.start()
    expect(s.getState()).toEqual({ status: 'unavailable' })
  })
})
