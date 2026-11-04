// In-memory auth session (ARC-11, CLAUDE.md §0.3).
// - The access token lives only in this object (never storage). The refresh token is the
//   HttpOnly cookie on the API origin, sent with `credentials: 'include'`.
// - Refreshes are single-flight in a tab and serialised across tabs with a Web Lock; the tab that
//   refreshed hands the new token to the others over a BroadcastChannel. A refresh answered 401
//   right after another tab rotated the cookie (the API's 10 s race window) adopts that tab's
//   token instead of signing out.

import { ApiError, apiErrorFrom } from '../api/errors'
import {
  AUTH_CHANNEL,
  REFRESH_LOCK,
  type AuthMessage,
  type SessionUser,
  type TokenMessage,
  parseAuthMessage,
  parseUser,
  usableShared,
} from './broadcast'
import { expiresAtFrom, isExpiringSoon } from './token'

export type AuthState =
  | { status: 'loading' }
  | { status: 'signedOut' }
  | { status: 'signedIn'; user: SessionUser }

type Channel = Pick<BroadcastChannel, 'postMessage' | 'close'> & {
  onmessage: ((event: MessageEvent) => void) | null
}
type Locks = { request<T>(name: string, cb: () => Promise<T>): Promise<T> }

export type SessionDeps = {
  fetch: typeof fetch
  now: () => number
  channel: Channel | null
  locks: Locks | null
}

/** How long a tab whose refresh got 401 waits for another tab's token (no Web Locks). */
const RACE_WAIT_MS = 1500
const RACE_WINDOW_MS = 10_000

function defaultDeps(): SessionDeps {
  const nav = typeof navigator === 'undefined' ? undefined : navigator
  return {
    fetch: (...args) => fetch(...args),
    now: () => Date.now(),
    channel: typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(AUTH_CHANNEL),
    locks: nav && 'locks' in nav ? (nav.locks as unknown as Locks) : null,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class AuthSession {
  private readonly authUrl: string
  private readonly deps: SessionDeps
  private state: AuthState = { status: 'loading' }
  private token: string | null = null
  private expiresAt: number | null = null
  private lastShared: TokenMessage | null = null
  private inflight: Promise<boolean> | null = null
  private readonly listeners = new Set<() => void>()

  constructor(authUrl: string, deps: SessionDeps = defaultDeps()) {
    this.authUrl = authUrl
    this.deps = deps
    if (deps.channel) deps.channel.onmessage = (event) => this.onMessage(parseAuthMessage(event.data))
  }

  getState = (): AuthState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get accessToken(): string | null {
    return this.token
  }

  /** Restore the session from the refresh cookie (app start). */
  async start(): Promise<void> {
    const ok = await this.refresh().catch(() => false)
    if (!ok && this.state.status === 'loading') this.setState({ status: 'signedOut' })
  }

  /** A token for the next request, refreshed first when it is about to expire. */
  async getToken(): Promise<string | null> {
    if (this.state.status !== 'signedIn') return null
    if (isExpiringSoon(this.expiresAt, this.deps.now())) {
      await this.refresh().catch(() => false) // network trouble: try the request anyway
    }
    return this.token
  }

  /** true = a fresh token is in memory. false = the session is gone (signed out). */
  refresh(): Promise<boolean> {
    this.inflight ??= this.refreshAcrossTabs().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  async signIn(identifier: string, password: string): Promise<SessionUser> {
    let response: Response
    try {
      response = await this.post('/auth/login', { identifier, password })
    } catch {
      throw apiErrorFrom(0, null)
    }
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok) throw apiErrorFrom(response.status, body)
    const msg = this.adoptTokenBody(body)
    if (!msg) throw new ApiError(response.status, 'bad_response', '')
    this.broadcast(msg)
    return msg.user
  }

  /** Always forgets the session in this browser. false = the API did not confirm the logout, so
   * the refresh cookie may still work (shared computer: the caller must tell the user). */
  async signOut(): Promise<boolean> {
    let confirmed = false
    try {
      confirmed = (await this.post('/auth/logout')).ok
    } catch {
      // offline
    }
    this.clear()
    this.broadcast({ type: 'signedOut' })
    return confirmed
  }

  close(): void {
    this.deps.channel?.close()
  }

  private async refreshAcrossTabs(): Promise<boolean> {
    const since = this.deps.now()
    const run = () => this.refreshOnce(since)
    return this.deps.locks ? this.deps.locks.request(REFRESH_LOCK, run) : run()
  }

  private async refreshOnce(since: number): Promise<boolean> {
    if (usableShared(this.lastShared, since, this.deps.now())) {
      this.adopt(this.lastShared)
      return true
    }
    let response: Response
    try {
      response = await this.post('/auth/refresh')
    } catch (err) {
      throw apiErrorFrom(0, err)
    }
    const body: unknown = await response.json().catch(() => null)
    if (response.ok) {
      const msg = this.adoptTokenBody(body)
      if (msg) {
        this.broadcast(msg)
        return true
      }
    } else if (response.status >= 500) {
      throw apiErrorFrom(response.status, body)
    }
    // 401/403: our cookie is gone or was just rotated by another tab.
    if (await this.waitForShared(since - RACE_WINDOW_MS)) return true
    this.clear()
    return false
  }

  private async waitForShared(since: number): Promise<boolean> {
    const deadline = this.deps.now() + (this.deps.locks ? 0 : RACE_WAIT_MS)
    for (;;) {
      if (usableShared(this.lastShared, since, this.deps.now())) {
        this.adopt(this.lastShared)
        return true
      }
      if (this.deps.now() >= deadline) return false
      await sleep(100)
    }
  }

  private post(path: string, json?: unknown): Promise<Response> {
    return this.deps.fetch(`${this.authUrl}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: json === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: json === undefined ? undefined : JSON.stringify(json),
    })
  }

  private adoptTokenBody(body: unknown): TokenMessage | null {
    if (typeof body !== 'object' || body === null) return null
    const b = body as Record<string, unknown>
    const user = parseUser(b.user)
    if (!user || typeof b.access_token !== 'string' || typeof b.expires_in !== 'number') return null
    const now = this.deps.now()
    const msg: TokenMessage = {
      type: 'token',
      accessToken: b.access_token,
      expiresAt: expiresAtFrom(b.expires_in, now),
      user,
      at: now,
    }
    this.adopt(msg)
    return msg
  }

  private adopt(msg: TokenMessage): void {
    this.token = msg.accessToken
    this.expiresAt = msg.expiresAt
    this.setState({ status: 'signedIn', user: msg.user })
  }

  private clear(): void {
    this.token = null
    this.expiresAt = null
    this.lastShared = null
    this.setState({ status: 'signedOut' })
  }

  private onMessage(msg: AuthMessage | null): void {
    if (!msg) return
    if (msg.type === 'signedOut') {
      this.clear()
      return
    }
    this.lastShared = msg
    this.adopt(msg)
  }

  private broadcast(msg: AuthMessage): void {
    try {
      this.deps.channel?.postMessage(msg)
    } catch {
      // a closed channel only costs the other tabs one extra refresh
    }
  }

  private setState(next: AuthState): void {
    const prev = this.state
    const same =
      prev.status === next.status &&
      (next.status !== 'signedIn' ||
        (prev.status === 'signedIn' &&
          prev.user.id === next.user.id &&
          prev.user.role === next.user.role &&
          prev.user.email === next.user.email &&
          prev.user.username === next.user.username))
    if (same) return // keep the snapshot stable for useSyncExternalStore
    this.state = next
    for (const listener of this.listeners) listener()
  }
}
