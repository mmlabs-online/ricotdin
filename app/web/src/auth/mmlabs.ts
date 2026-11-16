// mmlabs identity (AUT-05): ricotdin signs people in with their mmlabs account at
// api.mmlabs.online (org-admin `docs/consumers.md`). Pure helpers; AuthSession does the calls.

/** Our app key at mmlabs: the `X-MM-App` header and the token audience. */
export const MM_APP = 'ricotdin'
/** Where the chosen account of this browser is remembered (an account session id, not a secret). */
export const ACCOUNT_KEY = 'mm_account_id'

export type MmAccount = { accountId: string; email: string; emailVerified: boolean }
export type PendingAction = 'join' | 'joinClosed' | 'verify'

/** What a refused `/token` means for the user. */
export function actionFor(status: number, code: string, details: unknown): PendingAction | 'signedOut' | 'error' {
  if (status === 401) return 'signedOut'
  if (status === 403 && code === 'email_unverified') return 'verify'
  if (status === 403 && code === 'not_member') {
    const available = typeof details === 'object' && details !== null && (details as { join_available?: unknown }).join_available === true
    return available ? 'join' : 'joinClosed'
  }
  return 'error'
}

export function parseTokenBody(body: unknown): { accessToken: string; expiresIn: number } | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  if (typeof b.access_token !== 'string' || !b.access_token) return null
  if (typeof b.expires_in !== 'number' || b.audience !== MM_APP) return null
  return { accessToken: b.access_token, expiresIn: b.expires_in }
}

export function parseAccounts(body: unknown): MmAccount[] {
  const items = typeof body === 'object' && body !== null ? (body as { items?: unknown }).items : undefined
  if (!Array.isArray(items)) return []
  return items.flatMap((raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return []
    const a = raw as Record<string, unknown>
    if (typeof a.account_id !== 'string' || typeof a.email !== 'string') return []
    return [{ accountId: a.account_id, email: a.email, emailVerified: a.email_verified === true }]
  })
}

export type AccountStore = { get(): string | null; set(id: string): void; clear(): void }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** mmlabs account ids are UUIDs; anything else in storage is ignored (never sent). */
export function validAccountId(raw: string | null): string | null {
  return raw !== null && UUID.test(raw) ? raw : null
}

/** localStorage can throw (private mode, blocked storage): then the choice lives for the tab only. */
export function browserAccountStore(): AccountStore {
  let memory: string | null = null
  return {
    get: () => {
      try {
        return window.localStorage.getItem(ACCOUNT_KEY) ?? memory
      } catch {
        return memory
      }
    },
    set: (id) => {
      memory = id
      try {
        window.localStorage.setItem(ACCOUNT_KEY, id)
      } catch {
        // memory only
      }
    },
    clear: () => {
      memory = null
      try {
        window.localStorage.removeItem(ACCOUNT_KEY)
      } catch {
        // memory only
      }
    },
  }
}
