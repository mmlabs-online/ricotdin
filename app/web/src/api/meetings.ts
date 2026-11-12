// Meetings + folders data (ARC-13a). Optimistic pin / rename / move revert on error (spec).
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query'
import { useFetchApi } from '../auth/AuthProvider'
import { needsPolling, sortMeetings, withPin, withTitle, type MeetingRow } from '../lib/meetings/list'
import { meetingsAfterFolderDelete } from '../lib/folders/deleteNotice'
import { apiJson } from './json'

export interface Meeting extends MeetingRow {
  storage_provider: string | null
  audio_path: string | null
  audio_purged_at: string | null
  language: string | null
  summary: string | null
  notes: string | null
  /** PRO-06: the current text was written by a person (only then may it render links) */
  summary_edited?: boolean
  notes_edited?: boolean
  /** https targets the AI ever wrote in that field: they stay text even in a person's text */
  summary_ai_links?: string[]
  notes_ai_links?: string[]
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

export const MEETING_EDIT = ['meetings', 'edit'] as const

export function useMeetings() {
  const fetchApi = useFetchApi()
  const qc = useQueryClient()
  return useQuery({
    queryKey: keys.meetings,
    queryFn: async () => (await apiJson<{ meetings: Meeting[] }>(fetchApi, '/meetings')).meetings,
    // Keep the status fresh while something is uploading or processing (PRP-07), but never while
    // an edit is in flight: an older server list would briefly undo the optimistic change.
    refetchInterval: (q) =>
      q.state.data && needsPolling(q.state.data) && qc.isMutating({ mutationKey: MEETING_EDIT }) === 0 ? POLL_MS : false,
  })
}

export function useFolders() {
  const fetchApi = useFetchApi()
  return useQuery({
    queryKey: keys.folders,
    queryFn: async () => (await apiJson<{ folders: Folder[] }>(fetchApi, '/folders')).folders,
  })
}

/** Optimistic change of one meeting, rolled back for THAT meeting only if the request fails
 * (other rows may have their own edits in flight). The list is refetched once the last edit settles. */
function useRowMutation<V extends { id: string }, R>(
  kind: string,
  request: (v: V) => Promise<R>,
  apply: (list: Meeting[], v: V) => Meeting[],
  onServer?: (list: Meeting[], v: V, result: R) => Meeting[],
) {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: [...MEETING_EDIT, kind],
    mutationFn: request,
    onMutate: async (v: V) => {
      await qc.cancelQueries({ queryKey: keys.meetings })
      const before = qc.getQueryData<Meeting[]>(keys.meetings)?.find((m) => m.id === v.id)
      qc.setQueryData<Meeting[]>(keys.meetings, (list) => (list ? apply(list, v) : list))
      return { before }
    },
    onSuccess: (result, v) => {
      if (onServer) qc.setQueryData<Meeting[]>(keys.meetings, (list) => (list ? onServer(list, v, result) : list))
    },
    onError: (_err, v, ctx) => {
      const prev = ctx?.before
      if (prev) {
        qc.setQueryData<Meeting[]>(keys.meetings, (list) =>
          list ? sortMeetings(list.map((m) => (m.id === v.id ? prev : m))) : list,
        )
      }
    },
    onSettled: () => {
      // isMutating still counts this mutation while onSettled runs
      if (qc.isMutating({ mutationKey: MEETING_EDIT }) <= 1) void qc.invalidateQueries({ queryKey: keys.meetings })
    },
  })
}

export function usePinMeeting() {
  const fetchApi = useFetchApi()
  return useRowMutation<{ id: string; pinned: boolean }, { pinned_at?: string | null }>(
    'pin',
    // The API toggles (no body): callers disable the row's button while its pin is in flight.
    ({ id }) => apiJson(fetchApi, `/meetings/${encodeURIComponent(id)}/pin`, { method: 'PATCH' }),
    (list, { id, pinned }) => withPin(list, id, pinned ? new Date().toISOString() : null),
    // the toggle's real result wins over our guess
    (list, { id }, res) => (res && 'pinned_at' in res ? withPin(list, id, res.pinned_at ?? null) : list),
  )
}

/** Meeting ids whose pin request is in flight (each row disables its own button). */
export function usePinsInFlight(): Set<string> {
  const pending = useMutationState({
    filters: { mutationKey: [...MEETING_EDIT, 'pin'], status: 'pending' },
    select: (m) => (m.state.variables as { id?: string } | undefined)?.id,
  })
  return new Set(pending.filter((id): id is string => typeof id === 'string'))
}

export function useRenameMeeting() {
  const fetchApi = useFetchApi()
  return useRowMutation<{ id: string; title: string }, unknown>(
    'rename',
    ({ id, title }) => apiJson(fetchApi, `/meetings/${encodeURIComponent(id)}`, { method: 'PATCH', body: { title } }),
    (list, { id, title }) => withTitle(list, id, title),
  )
}

export function useMoveMeeting() {
  const fetchApi = useFetchApi()
  return useRowMutation<{ id: string; folderId: string | null }, unknown>(
    'move',
    ({ id, folderId }) =>
      apiJson(fetchApi, `/meetings/${encodeURIComponent(id)}`, { method: 'PATCH', body: { folder_id: folderId } }),
    (list, { id, folderId }) => list.map((m) => (m.id === id ? { ...m, folder_id: folderId } : m)),
  )
}

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
