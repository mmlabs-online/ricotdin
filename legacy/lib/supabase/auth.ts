'use client'

// Real auth helpers (Phase 7). Replaces the temporary anonymous sign-in.
// All functions read from the Supabase client's local session (localStorage).

import { browserClient } from './browser'

/** Returns the current access token, or null if not signed in. */
export async function getAccessToken(): Promise<string | null> {
  const { data: { session } } = await browserClient.auth.getSession()
  return session?.access_token ?? null
}

/**
 * Decode the JWT payload (no signature verification — that's Supabase's job).
 * Used to read custom claims like `user_role` without an extra server round-trip.
 */
function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const b64 = token.split('.')[1]
    if (!b64) return null
    return JSON.parse(atob(b64.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Returns the current user's role from the JWT, or null if not signed in.
 * The `user_role` claim is injected by the custom access token hook (migration 002).
 */
export async function getCurrentRole(): Promise<'user' | 'admin' | null> {
  const { data: { session } } = await browserClient.auth.getSession()
  if (!session) return null
  const payload = decodeJwt(session.access_token)
  const role = payload?.user_role
  if (role === 'admin') return 'admin'
  return 'user'
}

/** Sign out and clear the local session. Caller should redirect to /login. */
export async function signOut(): Promise<void> {
  await browserClient.auth.signOut()
}
