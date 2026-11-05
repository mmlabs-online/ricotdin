// Admin configuration data (ARC-14c): provider keys, app config, generation models, features,
// health, storage (§0.9 "Configuration (10c)"). Keys never come back: rows carry label + last4 only.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useFetchApi } from '../../auth/AuthProvider'
import type { FeatureFields, ModelPick } from '../../lib/admin/config'
import { apiErrorFrom } from '../errors'
import { apiJson } from '../json'

const enc = encodeURIComponent

export interface KeyRow {
  id: string
  created_at: string
  config_key: string
  label: string
  last4: string
  status: 'active' | 'disabled'
  disabled_reason: string | null
  last_used_at: string | null
  health_status: string | null
  health_checked_at: string | null
  health_detail: string | null
}
export interface ConfigRow {
  key: string
  value: unknown
  description: string | null
  updated_at: string | null
}
export interface GenerationConfig {
  systemDefault: ModelPick
  allowedModels: ModelPick[]
  registeredModels: (ModelPick & { label: string })[]
}
export interface Feature extends FeatureFields {
  id: string
  key: string
  module_prefix: string
  module_name: string
  user_story: string | null
  updated_at: string
  updated_by: string | null
}
export interface StorageStatus {
  drive: { ok: boolean; problem: string | null; account_email?: string | null; quota_used?: number | null; quota_limit?: number | null }
  objects: { count: number; bytes: number }
}

const keysKey = ['admin', 'keys'] as const

export function useKeys() {
  const fetchApi = useFetchApi()
  return useQuery({ queryKey: keysKey, queryFn: async () => (await apiJson<{ keys: KeyRow[] }>(fetchApi, '/admin/keys')).keys })
}

export function useLastKeyCheck() {
  const fetchApi = useFetchApi()
  return useQuery({
    queryKey: [...keysKey, 'check'],
    queryFn: async () => (await apiJson<{ lastCheckedAt: string | null }>(fetchApi, '/admin/keys/healthcheck')).lastCheckedAt,
  })
}

export function useKeyMutations() {
  const fetchApi = useFetchApi()
  const qc = useQueryClient()
  const done = () => void qc.invalidateQueries({ queryKey: keysKey })
  return {
    add: useMutation({
      mutationFn: (v: { configKey: string; label: string; key: string }) => apiJson<{ key: KeyRow }>(fetchApi, '/admin/keys', { method: 'POST', body: v }),
      onSettled: done,
    }),
    status: useMutation({
      mutationFn: ({ id, ...body }: { id: string; status: 'active' | 'disabled'; disabled_reason?: string }) =>
        apiJson<{ key: KeyRow }>(fetchApi, `/admin/keys/${enc(id)}`, { method: 'PATCH', body }),
      onSettled: done,
    }),
    remove: useMutation({
      mutationFn: (id: string) => apiJson(fetchApi, `/admin/keys/${enc(id)}`, { method: 'DELETE' }),
      onSettled: done,
    }),
    check: useMutation({
      mutationFn: () => apiJson<{ ranAt: string; summary: Record<string, number> }>(fetchApi, '/admin/keys/healthcheck', { method: 'POST' }),
      onSettled: () => {
        done()
        void qc.invalidateQueries({ queryKey: ['admin', 'health'] })
      },
    }),
  }
}

export function useAppConfig() {
  const fetchApi = useFetchApi()
  return useQuery({ queryKey: ['admin', 'config'], queryFn: async () => (await apiJson<{ config: ConfigRow[] }>(fetchApi, '/admin/config')).config })
}

export function useSaveConfig() {
  const fetchApi = useFetchApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) => apiJson(fetchApi, `/admin/config/${enc(key)}`, { method: 'PATCH', body: { value } }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['admin', 'config'] }),
  })
}

export function useGenerationConfig() {
  const fetchApi = useFetchApi()
  return useQuery({ queryKey: ['admin', 'generation'], queryFn: () => apiJson<GenerationConfig>(fetchApi, '/admin/generation-config') })
}

export function useSaveGeneration() {
  const fetchApi = useFetchApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { allowedModels: ModelPick[]; systemDefault: ModelPick }) => apiJson(fetchApi, '/admin/generation-config', { method: 'PATCH', body }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['admin', 'generation'] }),
  })
}

export function useFeatures() {
  const fetchApi = useFetchApi()
  // the registry is small (one page of ≤ 200, v1); filtering happens in the page
  return useQuery({ queryKey: ['admin', 'features'], queryFn: async () => (await apiJson<{ features: Feature[] }>(fetchApi, '/admin/features?perPage=200')).features })
}

export function useFeatureMutations() {
  const fetchApi = useFetchApi()
  const qc = useQueryClient()
  const done = () => void qc.invalidateQueries({ queryKey: ['admin', 'features'] })
  return {
    create: useMutation({
      mutationFn: (body: Record<string, unknown>) => apiJson<{ feature: Feature }>(fetchApi, '/admin/features', { method: 'POST', body }),
      onSettled: done,
    }),
    update: useMutation({
      mutationFn: ({ key, changes }: { key: string; changes: Partial<FeatureFields> }) =>
        apiJson<{ feature: Feature }>(fetchApi, `/admin/features/${enc(key)}`, { method: 'PATCH', body: changes }),
      onSettled: done,
    }),
  }
}

/** `/admin/health` answers 503 with the same body when something is degraded: read it either way. */
export function useHealthReport() {
  const fetchApi = useFetchApi()
  return useQuery({
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
      if (typeof body !== 'object' || body === null || typeof (body as { checks?: unknown }).checks !== 'object') {
        throw apiErrorFrom(res.ok ? 500 : res.status, null)
      }
      return body
    },
  })
}

export function useStorageStatus() {
  const fetchApi = useFetchApi()
  return useQuery({ queryKey: ['admin', 'storage'], queryFn: () => apiJson<StorageStatus>(fetchApi, '/admin/storage') })
}
