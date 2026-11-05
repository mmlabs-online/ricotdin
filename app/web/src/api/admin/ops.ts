// Admin operations data (ARC-14b): pipeline, schedulers, usage, activity, audit (§0.9).
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useFetchApi } from '../../auth/AuthProvider'
import type { DailyTotal, PipelineFilter, PipelineJob, UsageRow } from '../../lib/admin/ops'
import { apiJson } from '../json'

const enc = encodeURIComponent
export const PIPELINE_REFRESH_MS = 10_000

export interface JobRow extends PipelineJob {
  id: string
  title: string
  created_at: string
  updated_at: string
  duration_seconds: number | null
  error_message: string | null
  owner_email: string | null
  owner_username: string | null
}
export interface SchedulerTask {
  task: string
  every_seconds: number | null
  last_started_at: string | null
  last_finished_at: string | null
  last_status: string | null
  last_detail: string | null
  stale: boolean
}
export interface StorageUsage {
  meetings: { total: number; byStatus: Record<string, number>; failureRate: number; last7Days: number; last30Days: number }
  storage: { totalBytes: number; fileCount: number }
}
export interface AiUsage {
  from: string
  to: string
  rows: UsageRow[]
  dailyTotals: DailyTotal[]
}
export interface ActivityEvent {
  id: string
  created_at: string
  user_id: string
  user_email: string | null
  event_type: string
  meeting_id: string | null
  meeting_title: string | null
  metadata: unknown
  ip: string | null
}
export interface AuditEntry {
  id: string
  created_at: string
  actor_id: string | null
  actor_email: string | null
  action: string
  target_type: string | null
  target_id: string | null
  metadata: unknown
  ip_address: string | null
}

const query = (params: Record<string, string | number | null | undefined>) => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') q.set(k, String(v))
  return q.toString()
}

export function usePipelineJobs(p: { status: PipelineFilter; page: number; perPage: number }, live = true) {
  const fetchApi = useFetchApi()
  return useQuery({
    queryKey: ['admin', 'pipeline', 'jobs', p],
    placeholderData: keepPreviousData,
    refetchInterval: live ? PIPELINE_REFRESH_MS : false, // also paused while the tab is hidden (TanStack default)
    queryFn: () =>
      apiJson<{ jobs: JobRow[]; total: number; page: number; perPage: number }>(
        fetchApi,
        `/admin/pipeline/jobs?${query({ status: p.status === 'all' ? null : p.status, page: p.page, perPage: p.perPage })}`,
      ),
  })
}

export function usePipelineOverview(live = true) {
  const fetchApi = useFetchApi()
  return useQuery({
    queryKey: ['admin', 'pipeline', 'overview'],
    refetchInterval: live ? PIPELINE_REFRESH_MS : false,
    queryFn: () =>
      apiJson<{ counts: Record<'pending' | 'processing' | 'done' | 'failed' | 'stuck', number>; avg_processing_secs: number | null; total: number }>(
        fetchApi,
        '/admin/pipeline/overview',
      ),
  })
}

export function useSchedulers() {
  const fetchApi = useFetchApi()
  return useQuery({
    queryKey: ['admin', 'pipeline', 'schedulers'],
    refetchInterval: 60_000,
    queryFn: async () => (await apiJson<{ tasks: SchedulerTask[] }>(fetchApi, '/admin/pipeline/schedulers')).tasks,
  })
}

/** One requeue. The caller refreshes the lists once after a batch (`refreshPipeline`), not per item. */
export function useRequeue() {
  const fetchApi = useFetchApi()
  return useMutation({
    mutationFn: (meetingId: string) => apiJson(fetchApi, `/admin/pipeline/${enc(meetingId)}/requeue`, { method: 'POST' }),
  })
}

export function useRefreshPipeline() {
  const qc = useQueryClient()
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['admin', 'pipeline', 'jobs'] }),
      qc.invalidateQueries({ queryKey: ['admin', 'pipeline', 'overview'] }),
    ])
}

export function useStorageUsage() {
  const fetchApi = useFetchApi()
  return useQuery({ queryKey: ['admin', 'usage'], queryFn: () => apiJson<StorageUsage>(fetchApi, '/admin/usage') })
}

export function useAiUsage(p: { from: string; to: string; byOperation: boolean } | null) {
  const fetchApi = useFetchApi()
  return useQuery({
    queryKey: ['admin', 'ai-usage', p],
    enabled: p !== null,
    placeholderData: keepPreviousData,
    queryFn: () => apiJson<AiUsage>(fetchApi, `/admin/ai-usage?${query({ from: p?.from, to: p?.to, groupBy: p?.byOperation ? 'operation' : null })}`),
  })
}

export function useActivityFeed(p: { userId: string | null; eventType: string | null; from: string | null; to: string | null; page: number; perPage: number }) {
  const fetchApi = useFetchApi()
  return useQuery({
    queryKey: ['admin', 'activity', p],
    placeholderData: keepPreviousData,
    queryFn: () => apiJson<{ rows: ActivityEvent[]; total: number; page: number; perPage: number }>(fetchApi, `/admin/activity?${query(p)}`),
  })
}

export function useAuditLog(p: { actor: string | null; action: string | null; from: string | null; to: string | null; page: number; perPage: number }) {
  const fetchApi = useFetchApi()
  return useQuery({
    queryKey: ['admin', 'audit', p],
    placeholderData: keepPreviousData,
    queryFn: () => apiJson<{ logs: AuditEntry[]; total: number; page: number; perPage: number }>(fetchApi, `/admin/audit-logs?${query(p)}`),
  })
}
