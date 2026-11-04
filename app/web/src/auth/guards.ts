// Route guard rules (ARC-11). Pure: the components in RequireAuth.tsx apply them.

export type Role = 'user' | 'admin'
export type SessionView = { status: 'loading' } | { status: 'signedOut' } | { status: 'signedIn'; role: Role }
export type Decision = 'wait' | 'allow' | 'signIn' | 'forbidden'

export const HOME_PATH = '/meetings'
export const SIGN_IN_PATH = '/sign-in'

export function guardDecision(session: SessionView, needs: Role): Decision {
  if (session.status === 'loading') return 'wait'
  if (session.status === 'signedOut') return 'signIn'
  if (needs === 'admin' && session.role !== 'admin') return 'forbidden'
  return 'allow'
}

/** Only an in-app path is a valid place to return to after sign-in (no open redirect).
 * The fragment is dropped: email links carry their token there, and it must never reach a query. */
export function safeReturnTo(rawWithHash: string | null | undefined): string {
  const raw = rawWithHash?.split('#')[0]
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return HOME_PATH
  if ([...raw].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return HOME_PATH
  const path = raw.split(/[?#]/)[0] ?? ''
  if (path === SIGN_IN_PATH || path.startsWith(`${SIGN_IN_PATH}/`)) return HOME_PATH
  return raw
}

export function signInPath(pathname: string, search: string): string {
  const target = `${pathname}${search}`
  if (target === '/' || target === HOME_PATH) return SIGN_IN_PATH
  return `${SIGN_IN_PATH}?next=${encodeURIComponent(target)}`
}
