// Profile data (ARC-13c: PRF-01..04, AIP-06 default model, quota display).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApiUrl, useAuth, useFetchApi } from '../auth/AuthProvider'
import { putToDrive, uploadAvatar } from '../lib/upload/upload'
import { ApiError, apiErrorFrom } from './errors'
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
    mutationFn: (pick: { provider: string | null; model: string | null }) =>
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

/** `POST /profile/change-password`: the answer replaces the refresh cookie, so it goes through
 * the session (cookie jar + cross-tab refresh lock). Throws ApiError. */
export function useChangePassword() {
  const { session } = useAuth()
  const apiUrl = useApiUrl()
  return useMutation({
    mutationFn: async ({ current, next }: { current: string; next: string }) => {
      let res: Response
      try {
        res = await session.postWithCookie(`${apiUrl}/profile/change-password`, { current_password: current, new_password: next })
      } catch {
        throw new ApiError(0, 'network', '')
      }
      if (!res.ok) throw apiErrorFrom(res.status, await res.json().catch(() => null))
    },
  })
}
