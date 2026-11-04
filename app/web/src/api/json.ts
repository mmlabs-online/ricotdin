import type { FetchApi } from './client'
import { ApiError, apiErrorFrom } from './errors'

/** JSON request to the API; a non-2xx answer throws ApiError (code + status, never shown as text). */
export async function apiJson<T>(fetchApi: FetchApi, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response
  try {
    res = await fetchApi(path, {
      method: init?.method ?? 'GET',
      headers: init?.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    })
  } catch {
    throw new ApiError(0, 'network', '')
  }
  const body: unknown = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) throw apiErrorFrom(res.status, body)
  return body as T
}
