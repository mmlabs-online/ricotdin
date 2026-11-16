// In-memory auth session (ARC-11, AUT-05).
// - People sign in with their mmlabs account at api.mmlabs.online (`authUrl`): it keeps the
//   browser's device session (cookie `__Host-mm_device`, sent with `credentials: 'include'`) and
//   mints a short-lived per-app access token for the chosen account (`localStorage.mm_account_id`).
// - The token lives only in this object (never storage); ricotdin's API (`apiUrl`) verifies it and
//   answers `/auth/me` with the ricotdin user (id, username, role).
// - Token renewals are single-flight in a tab and serialised across tabs with a Web Lock; the tab
//   that renewed hands the new token to the others over a BroadcastChannel.

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
import {
  MM_APP,
  type AccountStore,
  type MmAccount,
  type PendingAction,
  actionFor,
  validAccountId,
  browserAccountStore,
  parseAccounts,
  parseTokenBody,
} from './mmlabs'
import { expiresAtFrom, isExpiringSoon } from './token'

export type AuthState =
  | { status: 'loading' }
  | { status: 'unavailable' } // mmlabs or the API could not answer at start: not signed out
  | { status: 'signedOut' }
  | { status: 'actionRequired'; action: PendingAction; accountId: string; email: string }
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
  account: AccountStore
}

/** An auth call must not hold the cross-tab lock forever when a server hangs. */
const AUTH_TIMEOUT_MS = 15_000

function defaultDeps(): SessionDeps {
  const nav = typeof navigator === 'undefined' ? undefined : navigator
  return {
    fetch: (...args) => fetch(...args),
    now: () => Date.now(),
    channel: typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(AUTH_CHANNEL),
    locks: nav && 'locks' in nav ? (nav.locks as unknown as Locks) : null,
    account: browserAccountStore(),
  }
}

export class AuthSession {
  private readonly authUrl: string
  private readonly apiUrl: string
  private readonly deps: SessionDeps
  private state: AuthState = { status: 'loading' }
  private token: string | null = null
  private expiresAt: number | null = null
  private lastShared: TokenMessage | null = null
  private inflight: Promise<boolean> | null = null
  /** Bumped by every sign-out: a renewal or shared token from an older epoch is discarded. */
  private epoch = 0
  private signedOutAt = Number.NEGATIVE_INFINITY
  private readonly listeners = new Set<() => void>()

  constructor(authUrl: string, apiUrl: string, deps: SessionDeps = defaultDeps()) {
    this.authUrl = authUrl
    this.apiUrl = apiUrl
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

  /** Restore the session of the chosen account (app start, or "retry" after `unavailable`). */
  async start(): Promise<void> {
    if (this.state.status === 'unavailable') this.setState({ status: 'loading' })
    try {
      await this.refresh() // false = signed out or an action is needed (state already set)
    } catch {
      if (this.state.status === 'loading') this.setState({ status: 'unavailable' })
    }
  }

  /** A token for the next request, renewed first when it is about to expire. */
  async getToken(): Promise<string | null> {
    if (this.state.status !== 'signedIn') return null
    if (isExpiringSoon(this.expiresAt, this.deps.now())) {
      await this.refresh().catch(() => false) // network trouble: try the request anyway
    }
    return this.token
  }

  /** true = a fresh token is in memory. false = signed out or an action is needed. */
  refresh(): Promise<boolean> {
    this.inflight ??= this.refreshAcrossTabs().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  /** Email + password at mmlabs (Turnstile token when mmlabs asked for one), then a ricotdin token. */
  async signIn(email: string, password: string, turnstileToken?: string): Promise<AuthState> {
    const payload: Record<string, string> = { email, password }
    if (turnstileToken) payload.turnstile_token = turnstileToken
    const body = await this.mmJson('POST', '/login', payload)
    const accountId = typeof body === 'object' && body !== null ? (body as { account_id?: unknown }).account_id : undefined
    if (typeof accountId !== 'string' || !accountId) throw new ApiError(200, 'bad_response', '')
    this.deps.account.set(accountId)
    await this.refresh()
    return this.state
  }

  /** Use an account already signed in on this browser ("Continue as …"). */
  async continueAs(accountId: string): Promise<AuthState> {
    this.deps.account.set(accountId)
    await this.refresh()
    return this.state
  }

  /** Join ricotdin with the chosen account. Only after the user clicked "Continue as" (consent). */
  async join(): Promise<AuthState> {
    const accountId = this.pendingAccount()
    await this.mmJson('POST', `/apps/${MM_APP}/join`, { account_id: accountId })
    this.deps.account.set(accountId) // another tab may have switched meanwhile: we joined this one
    await this.refresh()
    return this.state
  }

  /** New verification email for the account on screen. Already verified (409) → just continue. */
  async resendVerification(): Promise<AuthState> {
    const accountId = this.pendingAccount()
    try {
      await this.mmJson('POST', '/verify-email/resend', { account_id: accountId })
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'email_already_verified')) throw err
      this.deps.account.set(accountId)
      await this.refresh()
    }
    return this.state
  }

  /** The account the action screen shows (the click is the consent for exactly that account). */
  private pendingAccount(): string {
    if (this.state.status === 'actionRequired') return this.state.accountId
    const stored = this.currentAccount()
    if (!stored) throw new ApiError(401, 'session_invalid', '')
    return stored
  }

  private currentAccount(): string | null {
    return validAccountId(this.deps.account.get())
  }

  /** Accounts signed in on this browser (shared by every mmlabs app). Errors → empty list. */
  async accounts(): Promise<MmAccount[]> {
    try {
      return parseAccounts(await this.mmJson('GET', '/accounts'))
    } catch {
      return []
    }
  }

  /** Always forgets the session in this browser. false = mmlabs did not confirm the logout, so the
   * account may still be signed in at mmlabs (shared computer: the caller must tell the user). */
  async signOut(): Promise<boolean> {
    const accountId = this.currentAccount()
    // Forget the session at once, so a renewal still running in this tab cannot bring it back.
    this.clear(true)
    this.deps.account.clear()
    this.broadcast({ type: 'signedOut' })
    await this.inflight?.catch(() => false)
    let confirmed = true
    if (accountId) {
      try {
        confirmed = (await this.mm('POST', '/logout', { account_id: accountId })).ok
      } catch {
        confirmed = false // offline or timed out
      }
    }
    this.clear()
    this.broadcast({ type: 'signedOut' })
    return confirmed
  }

  /** Signed-out identity calls (sign-up, verify, forgot, reset): JSON to mmlabs with the app
   * header (mmlabs checks Origin + `X-MM-App`). Throws ApiError (code + status) on a non-2xx. */
  async publicAuth(path: string, json: unknown): Promise<unknown> {
    return this.mmJson('POST', path, json)
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
    const epoch = this.epoch
    if (usableShared(this.lastShared, since, this.deps.now())) {
      this.adopt(this.lastShared)
      return true
    }
    const accountId = this.currentAccount()
    if (!accountId) {
      this.clear()
      return false
    }
    let response: Response
    try {
      response = await this.mm('POST', '/token', { audience: MM_APP, account_id: accountId })
    } catch (err) {
      throw apiErrorFrom(0, err)
    }
    const body: unknown = await response.json().catch(() => null)
    if (epoch !== this.epoch) return false // signed out meanwhile: drop the answer
    if (!response.ok) {
      const error = apiErrorFrom(response.status, body)
      const action = actionFor(response.status, error.code, error.details)
      if (action === 'error') throw error // 5xx, 429, misconfiguration: keep what we have
      if (action === 'signedOut') {
        this.deps.account.clear()
        this.clear()
        return false
      }
      const email = (await this.accounts()).find((a) => a.accountId === accountId)?.email ?? ''
      if (epoch !== this.epoch) return false
      this.dropToken()
      this.setState({ status: 'actionRequired', action, accountId, email })
      return false
    }
    const token = parseTokenBody(body)
    if (!token) throw apiErrorFrom(response.status, null) // a proxy page, not a token answer
    const user = await this.me(token.accessToken)
    if (epoch !== this.epoch) return false
    const now = this.deps.now()
    const msg: TokenMessage = { type: 'token', accessToken: token.accessToken, expiresAt: expiresAtFrom(token.expiresIn, now), user, at: now }
    this.adopt(msg)
    this.broadcast(msg)
    return true
  }

  /** The ricotdin user for a fresh token. A ricotdin refusal (disabled, link conflict) signs out. */
  private async me(accessToken: string): Promise<SessionUser> {
    let res: Response
    try {
      res = await this.deps.fetch(`${this.apiUrl}/auth/me`, {
        method: 'GET',
        credentials: 'omit',
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
      })
    } catch (err) {
      throw apiErrorFrom(0, err)
    }
    const body: unknown = await res.json().catch(() => null)
    if (res.status === 403 || res.status === 409) {
      this.clear()
      throw apiErrorFrom(res.status, body)
    }
    if (!res.ok) throw apiErrorFrom(res.status, body)
    const user = parseUser(body)
    if (!user) throw apiErrorFrom(res.status, null)
    return user
  }

  private mm(method: 'GET' | 'POST', path: string, json?: unknown): Promise<Response> {
    const headers: Record<string, string> = { 'X-MM-App': MM_APP }
    if (json !== undefined) headers['Content-Type'] = 'application/json'
    return this.deps.fetch(`${this.authUrl}/api/v1/auth${path}`, {
      method,
      credentials: 'include',
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    })
  }

  private async mmJson(method: 'GET' | 'POST', path: string, json?: unknown): Promise<unknown> {
    let res: Response
    try {
      res = await this.mm(method, path, json)
    } catch {
      throw apiErrorFrom(0, null)
    }
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) throw apiErrorFrom(res.status, body)
    return body
  }

  private adopt(msg: TokenMessage): void {
    this.token = msg.accessToken
    this.expiresAt = msg.expiresAt
    this.setState({ status: 'signedIn', user: msg.user })
  }

  private dropToken(): void {
    this.token = null
    this.expiresAt = null
    this.lastShared = null
  }

  /** `signOut` = an explicit sign-out (here or in another tab): every renewal still running, in any
   * state, is discarded. Otherwise only a session that existed bumps the epoch. */
  private clear(signOut = false): void {
    if (signOut || this.state.status === 'signedIn' || this.token !== null) {
      this.epoch += 1
      this.signedOutAt = this.deps.now()
    }
    this.dropToken()
    this.setState({ status: 'signedOut' })
  }

  private onMessage(msg: AuthMessage | null): void {
    if (!msg) return
    if (msg.type === 'signedOut') {
      this.clear(true)
      return
    }
    if (msg.at <= this.signedOutAt) return // minted before our sign-out
    this.lastShared = msg
    this.adopt(msg)
  }

  private broadcast(msg: AuthMessage): void {
    try {
      this.deps.channel?.postMessage(msg)
    } catch {
      // a closed channel only costs the other tabs one extra renewal
    }
  }

  private setState(next: AuthState): void {
    const prev = this.state
    if (sameState(prev, next)) return // keep the snapshot stable for useSyncExternalStore
    this.state = next
    for (const listener of this.listeners) listener()
  }
}

function sameState(a: AuthState, b: AuthState): boolean {
  if (a.status !== b.status) return false
  if (a.status === 'signedIn' && b.status === 'signedIn') {
    return a.user.id === b.user.id && a.user.role === b.user.role && a.user.email === b.user.email && a.user.username === b.user.username
  }
  if (a.status === 'actionRequired' && b.status === 'actionRequired') {
    return a.action === b.action && a.accountId === b.accountId && a.email === b.email
  }
  return true
}
