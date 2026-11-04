// Typed client for the v2 API (ARC-11). Types come from src/api/schema.d.ts (scripts/gen-api.sh).
// Every request carries the in-memory access token; a 401 triggers one refresh and one retry.

import createClient from 'openapi-fetch'
import type { AuthSession } from '../auth/session'
import type { paths } from './schema'

export type ApiClient = ReturnType<typeof createClient<paths>>

function withToken(request: Request, token: string | null): Request {
  const next = new Request(request)
  if (token) next.headers.set('Authorization', `Bearer ${token}`)
  return next
}

/** The access token goes only to the API origin; any other URL is fetched as-is. */
export function authFetch(session: AuthSession, apiUrl: string, fetchFn: typeof fetch = (...a) => fetch(...a)) {
  const apiOrigin = new URL(apiUrl).origin
  return async (input: Request): Promise<Response> => {
    if (new URL(input.url).origin !== apiOrigin) return fetchFn(input)
    const retry = input.clone() // the body can be read only once
    const token = await session.getToken()
    const first = await fetchFn(withToken(input, token))
    if (first.status !== 401 || !token) return first
    // Another request already refreshed while this one was in flight: just retry with that token.
    const fresh = session.accessToken
    if (fresh && fresh !== token) return fetchFn(withToken(retry, fresh))
    if (!(await session.refresh().catch(() => false))) return first
    return fetchFn(withToken(retry, session.accessToken))
  }
}

export function createApiClient(apiUrl: string, session: AuthSession): ApiClient {
  return createClient<paths>({ baseUrl: apiUrl, fetch: authFetch(session, apiUrl) })
}
