// Messages shared between tabs of this origin (ARC-11): a tab that refreshed hands its new access
// token to the others, so only one tab rotates the refresh cookie at a time (CLAUDE.md §0.3).

import { REFRESH_SKEW_MS } from './token'

export type SessionUser = { id: string; email: string; username: string | null; role: 'user' | 'admin' }
export type TokenMessage = { type: 'token'; accessToken: string; expiresAt: number; user: SessionUser; at: number }
export type AuthMessage = TokenMessage | { type: 'signedOut' }

export const AUTH_CHANNEL = 'ricotdin-auth'
export const REFRESH_LOCK = 'ricotdin-auth-refresh'

export function parseUser(raw: unknown): SessionUser | null {
  if (typeof raw !== 'object' || raw === null) return null
  const u = raw as Record<string, unknown>
  if (typeof u.id !== 'string' || typeof u.email !== 'string') return null
  if (u.username !== null && typeof u.username !== 'string') return null
  if (u.role !== 'user' && u.role !== 'admin') return null
  return { id: u.id, email: u.email, username: u.username, role: u.role }
}

export function parseAuthMessage(raw: unknown): AuthMessage | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  if (m.type === 'signedOut') return { type: 'signedOut' }
  if (m.type !== 'token') return null
  const user = parseUser(m.user)
  if (!user || typeof m.accessToken !== 'string' || !m.accessToken) return null
  if (typeof m.expiresAt !== 'number' || typeof m.at !== 'number') return null
  return { type: 'token', accessToken: m.accessToken, expiresAt: m.expiresAt, user, at: m.at }
}

/** A token another tab got at or after `since` and that is not about to expire. */
export function usableShared(msg: TokenMessage | null, since: number, now: number): msg is TokenMessage {
  return msg !== null && msg.at >= since && msg.expiresAt - now > REFRESH_SKEW_MS
}
