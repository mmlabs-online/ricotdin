// Profile data (ARC-13c: PRF-01..04, AIP-06 default model, quota display).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useFetchApi } from '../auth/AuthProvider'
import { putToDrive, uploadAvatar } from '../lib/upload/upload'
import { apiJson } from './json'

export interface Profile {
  id: string
  email: string | null
  username: string | null
  display_name: string | null
  avatar_url: string | null
  role: string
  created_at: string
  meeting_count: number
  folder_count: number
  audio_seconds_remaining: number
  agent_queries_remaining: number
}
export interface Preferences {
  provider: string | null
  model: string | null
  /** PRF-07: folder new meetings go to when the client sends no folderId. */
  defaultFolderId: string | null
  /** PRF-06: UI language saved on the account; null = follow this device/browser. */
  locale: 'en' | 'vi' | null
  allowedModels: Array<{ provider: string; model: string; label: string }>
}

export const profileKeys = { profile: ['profile'] as const, preferences: ['profile', 'preferences'] as const }

export function useProfile() {
  const fetchApi = useFetchApi()
  return useQuery({ queryKey: profileKeys.profile, queryFn: () => apiJson<Profile>(fetchApi, '/profile') })
}

export function usePreferences() {
  const fetchApi = useFetchApi()
  return useQuery({ queryKey: profileKeys.preferences, queryFn: () => apiJson<Preferences>(fetchApi, '/profile/preferences') })
}

export function useUpdateProfile() {
  const fetchApi = useFetchApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (changes: { username?: string; display_name?: string | null }) =>
      apiJson(fetchApi, '/profile', { method: 'PATCH', body: changes }),
    onSettled: () => qc.invalidateQueries({ queryKey: profileKeys.profile, exact: true }),
  })
}

export function useUpdatePreferences() {
  const fetchApi = useFetchApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (
      pick: { provider: string | null; model: string | null } | { defaultFolderId: string | null } | { locale: 'en' | 'vi' | null },
    ) =>
      apiJson(fetchApi, '/profile/preferences', { method: 'PATCH', body: pick }),
    onSettled: () => qc.invalidateQueries({ queryKey: profileKeys.preferences, exact: true }),
  })
}

export function useUploadAvatar() {
  const fetchApi = useFetchApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ file, onProgress }: { file: File; onProgress?: (f: number) => void }) =>
      uploadAvatar({ fetchApi, putFile: (url, b, type, p) => putToDrive(url, b, type, p) }, file, onProgress),
    onSettled: () => qc.invalidateQueries({ queryKey: profileKeys.profile, exact: true }),
  })
}
