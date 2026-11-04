// Meetings + folders data (ARC-13a). Optimistic pin / rename / move revert on error (spec).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useFetchApi } from '../auth/AuthProvider'
import { needsPolling, withPin, withTitle, type MeetingRow } from '../lib/meetings/list'
import { meetingsAfterFolderDelete } from '../lib/folders/deleteNotice'
import { apiJson } from './json'

export interface Meeting extends MeetingRow {
  storage_provider: string | null
  audio_path: string | null
  audio_purged_at: string | null
  language: string | null
  summary: string | null
  notes: string | null
  started_at: string | null
  generation_provider: string | null
  generation_model: string | null
  updated_at: string
}

export type FolderRole = 'owner' | 'editor' | 'viewer'
export interface Folder {
  id: string
  user_id: string
  name: string
  position: number
  myRole: FolderRole
  ownerUsername: string | null
  memberCount: number
}
export interface ShareMember {
  userId: string
  username: string
  role: 'editor' | 'viewer'
}

export const keys = {
  meetings: ['meetings'] as const,
  folders: ['folders'] as const,
  shares: (folderId: string) => ['folders', folderId, 'shares'] as const,
}

const POLL_MS = 5000

export function useMeetings() {
  const fetchApi = useFetchApi()
  return useQuery({
    queryKey: keys.meetings,
    queryFn: async () => (await apiJson<{ meetings: Meeting[] }>(fetchApi, '/meetings')).meetings,
    // Keep the status fresh while something is uploading or processing (PRP-07).
    refetchInterval: (q) => (q.state.data && needsPolling(q.state.data) ? POLL_MS : false),
  })
}

export function useFolders() {
  const fetchApi = useFetchApi()
  return useQuery({
    queryKey: keys.folders,
    queryFn: async () => (await apiJson<{ folders: Folder[] }>(fetchApi, '/folders')).folders,
  })
}

/** Optimistic change of the cached list, rolled back if the request fails. */
function useListMutation<V>(request: (v: V) => Promise<unknown>, apply: (list: Meeting[], v: V) => Meeting[]) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: request,
    onMutate: async (v: V) => {
      await qc.cancelQueries({ queryKey: keys.meetings })
      const before = qc.getQueryData<Meeting[]>(keys.meetings)
      if (before) qc.setQueryData(keys.meetings, apply(before, v))
      return { before }
    },
    onError: (_err, _v, ctx) => {
      if (ctx?.before) qc.setQueryData(keys.meetings, ctx.before)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.meetings }),
  })
}

export function usePinMeeting() {
  const fetchApi = useFetchApi()
  return useListMutation<{ id: string; pinned: boolean }>(
    // The API toggles (no body): callers disable the button while a pin request is in flight.
    ({ id }) => apiJson(fetchApi, `/meetings/${encodeURIComponent(id)}/pin`, { method: 'PATCH' }),
    (list, { id, pinned }) => withPin(list, id, pinned ? new Date().toISOString() : null),
  )
}

export function useRenameMeeting() {
  const fetchApi = useFetchApi()
  return useListMutation<{ id: string; title: string }>(
    ({ id, title }) => apiJson(fetchApi, `/meetings/${encodeURIComponent(id)}`, { method: 'PATCH', body: { title } }),
    (list, { id, title }) => withTitle(list, id, title),
  )
}

export function useMoveMeeting() {
  const fetchApi = useFetchApi()
  return useListMutation<{ id: string; folderId: string | null }>(
    ({ id, folderId }) =>
      apiJson(fetchApi, `/meetings/${encodeURIComponent(id)}`, { method: 'PATCH', body: { folder_id: folderId } }),
    (list, { id, folderId }) => list.map((m) => (m.id === id ? { ...m, folder_id: folderId } : m)),
  )
}

/** Not optimistic: the API deletes the audio first and may answer with a storage warning. */
export function useDeleteMeeting() {
  const fetchApi = useFetchApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiJson<{ ok: boolean; warning?: string }>(fetchApi, `/meetings/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: (_r, id) => qc.setQueryData<Meeting[]>(keys.meetings, (list) => list?.filter((m) => m.id !== id)),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.meetings }),
  })
}

// --- folders -----------------------------------------------------------------------------------

function useFolderMutation<V, R = unknown>(request: (v: V) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: request,
    onSettled: () => qc.invalidateQueries({ queryKey: keys.folders }),
  })
}

export function useCreateFolder() {
  const fetchApi = useFetchApi()
  return useFolderMutation((name: string) => apiJson(fetchApi, '/folders', { method: 'POST', body: { name } }))
}

export function useRenameFolder() {
  const fetchApi = useFetchApi()
  return useFolderMutation(({ id, name }: { id: string; name: string }) =>
    apiJson(fetchApi, `/folders/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } }),
  )
}

export function useReorderFolders() {
  const fetchApi = useFetchApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (order: string[]) => apiJson(fetchApi, '/folders/reorder', { method: 'PUT', body: { order } }),
    onMutate: async (order: string[]) => {
      await qc.cancelQueries({ queryKey: keys.folders })
      const before = qc.getQueryData<Folder[]>(keys.folders)
      if (before) {
        const rank = new Map(order.map((id, i) => [id, i]))
        qc.setQueryData(
          keys.folders,
          [...before].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity)),
        )
      }
      return { before }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.before) qc.setQueryData(keys.folders, ctx.before)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.folders }),
  })
}

export function useDeleteFolder(callerId: string) {
  const fetchApi = useFetchApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, deleteMeetings }: { id: string; deleteMeetings: boolean }) =>
      apiJson(fetchApi, `/folders/${encodeURIComponent(id)}${deleteMeetings ? '?deleteMeetings=true' : ''}`, {
        method: 'DELETE',
      }),
    onSuccess: (_r, { id, deleteMeetings }) => {
      qc.setQueryData<Meeting[]>(keys.meetings, (list) =>
        list ? meetingsAfterFolderDelete(list, id, callerId, deleteMeetings) : list,
      )
    },
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: keys.folders }), qc.invalidateQueries({ queryKey: keys.meetings })]),
  })
}

export function useShares(folderId: string | null) {
  const fetchApi = useFetchApi()
  return useQuery({
    queryKey: keys.shares(folderId ?? ''),
    enabled: folderId !== null,
    queryFn: async () =>
      (await apiJson<{ members: ShareMember[] }>(fetchApi, `/folders/${encodeURIComponent(folderId ?? '')}/shares`)).members,
  })
}

export function useShareMutations(folderId: string) {
  const fetchApi = useFetchApi()
  const qc = useQueryClient()
  const refresh = () =>
    Promise.all([qc.invalidateQueries({ queryKey: keys.shares(folderId) }), qc.invalidateQueries({ queryKey: keys.folders })])
  const base = `/folders/${encodeURIComponent(folderId)}/shares`
  return {
    add: useMutation({
      mutationFn: (v: { identifier: string; role: 'editor' | 'viewer' }) => apiJson(fetchApi, base, { method: 'POST', body: v }),
      onSettled: refresh,
    }),
    change: useMutation({
      mutationFn: (v: { userId: string; role: 'editor' | 'viewer' }) =>
        apiJson(fetchApi, `${base}/${encodeURIComponent(v.userId)}`, { method: 'PATCH', body: { role: v.role } }),
      onSettled: refresh,
    }),
    remove: useMutation({
      mutationFn: (userId: string) => apiJson(fetchApi, `${base}/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
      onSettled: refresh,
    }),
  }
}
