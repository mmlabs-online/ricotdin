// Dev only (OPS-08): the dev server adds the bearer token, so the session is just `/auth/me`.
// Anything but a valid user (no token, expired, API down) shows the retry screen, never the
// sign-in page (mmlabs sign-in cannot run from localhost).

import { apiErrorFrom } from '../api/errors'
import { parseUser } from './broadcast'
import type { AuthState } from './session'

const TIMEOUT_MS = 15_000

export function devAuthState(status: number, body: unknown): AuthState {
  const user = status === 200 ? parseUser(body) : null
  return user ? { status: 'signedIn', user } : { status: 'unavailable' }
}

/** `/auth/me` through the dev server (it adds the token). A free function, so the build drops it. */
export async function fetchDevState(fetchFn: typeof fetch, apiUrl: string): Promise<AuthState> {
  let res: Response
  try {
    res = await fetchFn(`${apiUrl}/auth/me`, { method: 'GET', credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (err) {
    throw apiErrorFrom(0, err)
  }
  const body: unknown = await res.json().catch(() => null)
  return devAuthState(res.status, body)
}
