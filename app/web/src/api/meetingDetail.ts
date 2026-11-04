// Meeting detail data (ARC-13b). Optimistic to-do / dismiss / rename / move revert on error (spec).
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { useFetchApi } from '../auth/AuthProvider'
import { normalizeChat, normalizeMessage, type ChatMessage } from '../lib/chat/chat'
import type { CalendarSuggestion, Todo, TodoStatus } from '../lib/meetings/detail'
import { needsPolling } from '../lib/meetings/list'
import type { TranscriptSegment } from '../lib/transcript/export'
import { apiJson } from './json'
import { keys as listKeys, type Meeting } from './meetings'

const POLL_MS = 5000
const enc = encodeURIComponent

export const detailKeys = {
  meeting: (id: string) => ['meeting', id] as const,
  transcript: (id: string) => ['meeting', id, 'transcript'] as const,
  todos: (id: string) => ['meeting', id, 'todos'] as const,
  suggestions: (id: string) => ['meeting', id, 'suggestions'] as const,
  audio: (id: string) => ['meeting', id, 'audio'] as const,
  chat: (id: string) => ['meeting', id, 'chat'] as const,
}
const DETAIL_EDIT = ['meeting', 'edit'] as const

export function useMeeting(id: string) {
  const fetchApi = useFetchApi()
  const qc = useQueryClient()
  return useQuery({
    queryKey: detailKeys.meeting(id),
    queryFn: () => apiJson<Meeting>(fetchApi, `/meetings/${enc(id)}`),
    // Follow processing (PRP-07); never while an edit is in flight (an older answer would undo it).
    refetchInterval: (q) =>
      q.state.data && needsPolling([q.state.data]) && qc.isMutating({ mutationKey: DETAIL_EDIT }) === 0 ? POLL_MS : false,
  })
}

function useChild<T>(key: QueryKey, path: string, field: string, enabled: boolean) {
  const fetchApi = useFetchApi()
  return useQuery({
    queryKey: key,
    enabled,
    queryFn: async () => {
      const body = await apiJson<Record<string, unknown>>(fetchApi, path)
      const list = body?.[field]
      return Array.isArray(list) ? (list as T[]) : []
    },
  })
}

export const useTranscript = (id: string, enabled: boolean) =>
  useChild<TranscriptSegment>(detailKeys.transcript(id), `/meetings/${enc(id)}/transcript`, 'segments', enabled)
export const useTodos = (id: string, enabled: boolean) =>
  useChild<Todo>(detailKeys.todos(id), `/meetings/${enc(id)}/todos`, 'todos', enabled)
export const useSuggestions = (id: string, enabled: boolean) =>
  useChild<CalendarSuggestion>(detailKeys.suggestions(id), `/meetings/${enc(id)}/calendar-suggestions`, 'suggestions', enabled)

/** Playback link (15 min, §0.6). Kept until the player reports an error, then fetched again. */
export function useAudioUrl(id: string, enabled: boolean) {
  const fetchApi = useFetchApi()
  return useQuery({
    queryKey: detailKeys.audio(id),
    enabled,
    staleTime: Infinity,
    gcTime: 60_000,
    queryFn: () => apiJson<{ url: string; hackAudioRender: boolean }>(fetchApi, `/meetings/${enc(id)}/audio-url`),
  })
}

/** Optimistic change of one cached value, rolled back if the request fails. */
function useOptimisticEdit<V, T>(kind: string, key: QueryKey, request: (v: V) => Promise<unknown>, apply: (data: T, v: V) => T, after?: QueryKey[]) {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: [...DETAIL_EDIT, kind],
    mutationFn: request,
    onMutate: async (v: V) => {
      await qc.cancelQueries({ queryKey: key, exact: true })
      const before = qc.getQueryData<T>(key)
      if (before !== undefined) qc.setQueryData<T>(key, apply(before, v))
      return { before }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.before !== undefined) qc.setQueryData(key, ctx.before)
    },
    onSettled: () => {
      if (qc.isMutating({ mutationKey: [...DETAIL_EDIT, kind] }) <= 1) {
        void qc.invalidateQueries({ queryKey: key, exact: true })
        for (const k of after ?? []) void qc.invalidateQueries({ queryKey: k })
      }
    },
  })
}

export function useTodoStatus(meetingId: string) {
  const fetchApi = useFetchApi()
  return useOptimisticEdit<{ id: string; status: TodoStatus }, Todo[]>(
    'todo',
    detailKeys.todos(meetingId),
    ({ id, status }) => apiJson(fetchApi, `/todos/${enc(id)}`, { method: 'PATCH', body: { status } }),
    (list, { id, status }) => list.map((t) => (t.id === id ? { ...t, status } : t)),
  )
}

export function useDismissSuggestion(meetingId: string) {
  const fetchApi = useFetchApi()
  return useOptimisticEdit<string, CalendarSuggestion[]>(
    'dismiss',
    detailKeys.suggestions(meetingId),
    (id) => apiJson(fetchApi, `/calendar-suggestions/${enc(id)}`, { method: 'PATCH', body: { dismissed: true } }),
    (list, id) => list.map((s) => (s.id === id ? { ...s, dismissed: true } : s)),
  )
}

export function useRenameDetail(meetingId: string) {
  const fetchApi = useFetchApi()
  return useOptimisticEdit<string, Meeting>(
    'rename',
    detailKeys.meeting(meetingId),
    (title) => apiJson(fetchApi, `/meetings/${enc(meetingId)}`, { method: 'PATCH', body: { title } }),
    (m, title) => ({ ...m, title }),
    [listKeys.meetings],
  )
}

export function useMoveDetail(meetingId: string) {
  const fetchApi = useFetchApi()
  return useOptimisticEdit<string | null, Meeting>(
    'move',
    detailKeys.meeting(meetingId),
    (folderId) => apiJson(fetchApi, `/meetings/${enc(meetingId)}`, { method: 'PATCH', body: { folder_id: folderId } }),
    (m, folderId) => ({ ...m, folder_id: folderId }),
    [listKeys.meetings],
  )
}

export function useRegenerate(meetingId: string) {
  const fetchApi = useFetchApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiJson<{ ok: boolean; summary: string | null; notes: string | null }>(fetchApi, `/meetings/${enc(meetingId)}/regenerate`, {
        method: 'POST',
      }),
    onSuccess: (r) =>
      qc.setQueryData<Meeting>(detailKeys.meeting(meetingId), (m) =>
        m ? { ...m, status: 'done', error_message: null, summary: r.summary ?? null, notes: r.notes ?? null } : m,
      ),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: detailKeys.meeting(meetingId), exact: true })
    },
  })
}

export function useProcess(meetingId: string) {
  const fetchApi = useFetchApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => apiJson(fetchApi, `/meetings/${enc(meetingId)}/process`, { method: 'POST' }),
    // The job is queued; the worker moves the meeting to `processing` when it claims it (about a
    // second). Show it as processing now and let the 5 s polling bring the real status, instead of
    // refetching at once and briefly showing the old `failed` / `done` again.
    onSuccess: () => {
      qc.setQueryData<Meeting>(detailKeys.meeting(meetingId), (m) => (m ? { ...m, status: 'processing', error_message: null } : m))
      void qc.invalidateQueries({ queryKey: listKeys.meetings })
    },
  })
}

// --- chat about this meeting (RAG-01/03) -------------------------------------------------------

export interface MeetingChat {
  sessionId: string | null
  messages: ChatMessage[]
}

export function useMeetingChat(meetingId: string, enabled: boolean) {
  const fetchApi = useFetchApi()
  return useQuery({
    queryKey: detailKeys.chat(meetingId),
    enabled,
    queryFn: async () => normalizeChat(await apiJson<unknown>(fetchApi, `/chat?meetingId=${enc(meetingId)}`)),
  })
}

export function useAskMeeting(meetingId: string) {
  const fetchApi = useFetchApi()
  const qc = useQueryClient()
  const key = detailKeys.chat(meetingId)
  return useMutation({
    mutationFn: ({ message, sessionId }: { message: string; sessionId: string | null }) =>
      apiJson<{ sessionId: string; message: unknown }>(fetchApi, '/chat', {
        method: 'POST',
        body: sessionId ? { message, meetingId, sessionId } : { message, meetingId },
      }),
    onSuccess: (res, { message }) => {
      const reply = normalizeMessage(res.message)
      qc.setQueryData<MeetingChat>(key, (chat) => {
        const question: ChatMessage = { id: `local-${Date.now()}`, role: 'user', content: message, citations: [], createdAt: '' }
        const messages = [...(chat?.messages ?? []), question, ...(reply ? [reply] : [])]
        return { sessionId: typeof res.sessionId === 'string' ? res.sessionId : (chat?.sessionId ?? null), messages }
      })
    },
    // The saved question gets its real id (and a failed answer its stored reply). Not awaited: the
    // caller's own callbacks (which drop the "sending" bubble) must run as soon as the answer is in.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key, exact: true })
    },
  })
}
