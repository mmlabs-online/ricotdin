// Admin users + overview data (ARC-14a). All routes are `current_admin` (§0.9): the API
// re-checks the caller's role on every request.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useFetchApi } from '../../auth/AuthProvider'
import type { AdminUser } from '../../lib/admin/users'
import { apiErrorFrom } from '../errors'
import { apiJson } from '../json'

const enc = encodeURIComponent

export interface AdminUserRow extends AdminUser {
  meeting_count: number
  gemini_tokens: number
  audio_seconds: number
}
export interface UserList {
  users: AdminUserRow[]
  total: number
  page: number
  perPage: number
  month: string
}
export interface QuotaInfo {
  wallet: { audio_seconds_remaining: number; agent_queries_remaining: number; updated_at: string | null }
  ledger: Array<{
    id: string
    created_at: string
    reason: string
    delta_audio_seconds: number
    delta_agent_queries: number
    created_by: string | null
  }>
}
export interface ActivityRow {
  id: string
  created_at: string
  event_type: string
  meeting_title: string | null
}
export interface AuditRow {
  id: string
  created_at: string
  actor_email: string | null
  action: string
  target_type: string | null
}

export const adminKeys = {
  all: ['admin'] as const,
  users: ['admin', 'users'] as const,
  list: (p: object) => ['admin', 'users', 'list', p] as const,
  user: (id: string) => ['admin', 'users', id] as const,
  quota: (id: string) => ['admin', 'users', id, 'quota'] as const,
  activity: (id: string) => ['admin', 'users', id, 'activity'] as const,
}

export function useAdminUsers(params: { page: number; perPage: number; search: string; month: string }) {
  const fetchApi = useFetchApi()
  const q = new URLSearchParams({ page: String(params.page), perPage: String(params.perPage), month: params.month })
  if (params.search) q.set('search', params.search)
  return useQuery({
    queryKey: adminKeys.list(params),
    placeholderData: keepPreviousData,
    queryFn: () => apiJson<UserList>(fetchApi, `/admin/users?${q.toString()}`),
  })
}

export function useAdminUser(id: string) {
  const fetchApi = useFetchApi()
  return useQuery({
    queryKey: adminKeys.user(id),
    queryFn: () => apiJson<AdminUser & { meeting_count: number }>(fetchApi, `/admin/users/${enc(id)}`),
  })
}

export function useUserQuota(id: string) {
  const fetchApi = useFetchApi()
  return useQuery({ queryKey: adminKeys.quota(id), queryFn: () => apiJson<QuotaInfo>(fetchApi, `/admin/users/${enc(id)}/quota`) })
}

export function useUserActivity(id: string) {
  const fetchApi = useFetchApi()
  return useQuery({
    queryKey: adminKeys.activity(id),
    queryFn: async () => (await apiJson<{ rows: ActivityRow[] }>(fetchApi, `/admin/activity?userId=${enc(id)}&perPage=10`)).rows,
  })
}

type Detail = AdminUser & { meeting_count: number }

/** Any change to a user: refresh the lists and that user. `patch` writes the answer into the
 * detail at once, so the old control never comes back before the refetch lands. */
function useUserMutation<V, R = unknown>(request: (v: V) => Promise<R>, patch?: (v: V) => { id: string; change: (old: Detail) => Partial<Detail> }) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: request,
    onSuccess: (_r, v) => {
      if (!patch) return
      const { id, change } = patch(v)
      qc.setQueryData<Detail>(adminKeys.user(id), (old) => (old ? { ...old, ...change(old) } : old))
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: adminKeys.users })
    },
  })
}

export function useUserMutations() {
  const fetchApi = useFetchApi()
  const qc = useQueryClient()
  return {
    role: useUserMutation(
      ({ id, role }: { id: string; role: 'user' | 'admin' }) => apiJson(fetchApi, `/admin/users/${enc(id)}/role`, { method: 'PATCH', body: { role } }),
      ({ id, role }) => ({ id, change: () => ({ role }) }),
    ),
    status: useUserMutation(
      ({ id, disabled }: { id: string; disabled: boolean }) => apiJson(fetchApi, `/admin/users/${enc(id)}/status`, { method: 'PATCH', body: { disabled } }),
      ({ id, disabled }) => ({
        id,
        change: (old) => ({ disabled, status: disabled ? 'disabled' : old.email_confirmed ? 'active' : 'unverified' }),
      }),
    ),
    reset: useUserMutation((id: string) =>
      apiJson<{ ok: boolean; email_sent?: boolean }>(fetchApi, `/admin/users/${enc(id)}/reset-password`, { method: 'POST' }),
    ),
    // the user is gone: drop their detail, quota and activity instead of refetching them (404)
    remove: useMutation({
      mutationFn: (id: string) => apiJson<{ ok: boolean; storageWarnings?: string[] }>(fetchApi, `/admin/users/${enc(id)}`, { method: 'DELETE' }),
      onSuccess: (_r, id) => {
        void qc.cancelQueries({ queryKey: adminKeys.user(id) })
        qc.removeQueries({ queryKey: adminKeys.user(id) })
      },
      onSettled: () => {
        void qc.invalidateQueries({ queryKey: adminKeys.users, refetchType: 'active' })
      },
    }),
    bulk: useUserMutation((v: { ids: string[]; action: 'disable' | 'enable' | 'set_role'; role?: 'user' | 'admin' }) =>
      apiJson<unknown>(fetchApi, '/admin/users/bulk', { method: 'POST', body: v }),
    ),
    grant: useUserMutation(({ id, ...body }: { id: string; audio_minutes?: number; agent_queries?: number; note?: string }) =>
      apiJson(fetchApi, `/admin/users/${enc(id)}/quota`, { method: 'POST', body }),
    ),
  }
}

// --- overview ------------------------------------------------------------------------------------

export interface PipelineOverview {
  counts: { pending: number; processing: number; done: number; failed: number; stuck: number }
  avg_processing_secs: number | null
  total: number
}

export function useOverview() {
  const fetchApi = useFetchApi()
  return {
    pipeline: useQuery({
      queryKey: ['admin', 'pipeline', 'overview'],
      queryFn: () => apiJson<PipelineOverview>(fetchApi, '/admin/pipeline/overview'),
    }),
    users: useQuery({
      queryKey: ['admin', 'users', 'count'],
      queryFn: async () => (await apiJson<UserList>(fetchApi, '/admin/users?perPage=1')).total,
    }),
    // answers 503 with the same body when something is degraded: read it either way
    health: useQuery({
      queryKey: ['admin', 'health'],
      queryFn: async () => {
        let res: Response
        try {
          res = await fetchApi('/admin/health')
        } catch {
          throw apiErrorFrom(0, null)
        }
        const body: unknown = await res.json().catch(() => null)
        if (!res.ok && res.status !== 503) throw apiErrorFrom(res.status, body)
        // a proxy's 503 page or an empty answer is an error, not "degraded"
        if (typeof body !== 'object' || body === null || typeof (body as { checks?: unknown }).checks !== 'object') {
          throw apiErrorFrom(res.ok ? 500 : res.status, null)
        }
        return body
      },
    }),
    audit: useQuery({
      queryKey: ['admin', 'audit', 'recent'],
      queryFn: async () => (await apiJson<{ logs: AuditRow[] }>(fetchApi, '/admin/audit-logs?perPage=5')).logs,
    }),
  }
}
