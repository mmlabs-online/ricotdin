// Dev only (OPS-08): the dev server adds the bearer token, so the session is just `/auth/me`.
// Anything but a valid user (no token, expired, API down) shows the retry screen, never the
// sign-in page (mmlabs sign-in cannot run from localhost).

import { parseUser } from './broadcast'
import type { AuthState } from './session'

export function devAuthState(status: number, body: unknown): AuthState {
  const user = status === 200 ? parseUser(body) : null
  return user ? { status: 'signedIn', user } : { status: 'unavailable' }
}
