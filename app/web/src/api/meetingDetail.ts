// Meeting detail data (ARC-13b). Optimistic to-do / dismiss / rename / move revert on error (spec).
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { useFetchApi } from '../auth/AuthProvider'
import { normalizeChat, normalizeMessage, type ChatMessage } from '../lib/chat/chat'
import { isQueued, restoreRow, type CalendarSuggestion, type Todo, type TodoStatus } from '../lib/meetings/detail'
import { normalizeVersion, normalizeVersions } from '../lib/meetings/history'
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

/** While a re-queued failed meeting waits for a free worker (`isQueued`), keep polling up to this
 * long: the worker runs one job at a time, each step up to 12 min. */
export const FOLLOW_QUEUED_MS = 20 * 60_000

export function useMeeting(id: string, queued: { at: string; since: number } | null = null) {
  const fetchApi = useFetchApi()
  const qc = useQueryClient()
  return useQuery({
    queryKey: detailKeys.meeting(id),
    queryFn: () => apiJson<Meeting>(fetchApi, `/meetings/${enc(id)}`),
    // Follow processing (PRP-07) and a queued re-run; never while an edit is in flight (an older
    // answer would undo it).
    refetchInterval: (q) => {
      const m = q.state.data
      if (!m || qc.isMutating({ mutationKey: DETAIL_EDIT }) > 0) return false
      const waiting = queued !== null && isQueued(m, queued.at) && Date.now() - queued.since < FOLLOW_QUEUED_MS
      return needsPolling([m]) || waiting ? POLL_MS : false
    },
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

/** Optimistic change of one cached value. A failure undoes only THIS change (`undo` gets the value
 * from before it), so other edits in flight stay on screen; data is refetched once the last edit
 * of the page settles. */
function useOptimisticEdit<V, T>(
  kind: string,
  key: QueryKey,
  request: (v: V) => Promise<unknown>,
  apply: (data: T, v: V) => T,
  undo: (data: T, v: V, before: T) => T,
  after?: QueryKey[],
) {
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
    onError: (_e, v, ctx) => {
      const before = ctx?.before
      if (before !== undefined) qc.setQueryData<T>(key, (now) => (now === undefined ? before : undo(now, v, before)))
    },
    onSettled: () => {
      // all kinds count: rename and move share the meeting key
      if (qc.isMutating({ mutationKey: DETAIL_EDIT }) <= 1) {
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
    (list, { id }, before) => {
      const prev = before.find((t) => t.id === id)
      return prev ? restoreRow(list, prev) : list
    },
  )
}

export function useDismissSuggestion(meetingId: string) {
  const fetchApi = useFetchApi()
  return useOptimisticEdit<string, CalendarSuggestion[]>(
    'dismiss',
    detailKeys.suggestions(meetingId),
    (id) => apiJson(fetchApi, `/calendar-suggestions/${enc(id)}`, { method: 'PATCH', body: { dismissed: true } }),
    (list, id) => list.map((s) => (s.id === id ? { ...s, dismissed: true } : s)),
    (list, id, before) => {
      const prev = before.find((s) => s.id === id)
      return prev ? restoreRow(list, prev) : list
    },
  )
}

export function useRenameDetail(meetingId: string) {
  const fetchApi = useFetchApi()
  return useOptimisticEdit<string, Meeting>(
    'rename',
    detailKeys.meeting(meetingId),
    (title) => apiJson(fetchApi, `/meetings/${enc(meetingId)}`, { method: 'PATCH', body: { title } }),
    (m, title) => ({ ...m, title }),
    (m, _title, before) => ({ ...m, title: before.title }),
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
    (m, _folderId, before) => ({ ...m, folder_id: before.folder_id }),
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
      void qc.invalidateQueries({ queryKey: ['meeting', meetingId, 'versions'] }) // regenerate writes versions
    },
  })
}

export function useProcess(meetingId: string) {
  const fetchApi = useFetchApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => apiJson(fetchApi, `/meetings/${enc(meetingId)}/process`, { method: 'POST' }),
    // A job is queued; the meeting stays `failed` until a worker claims it. The page shows it as
    // queued (`isQueued`) and keeps polling (`useMeeting`'s `queued`).
    onSuccess: () => {
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
    // The API stores the question before it answers: a refetch while waiting would show it next to
    // the local "sending" bubble. Refetch only after a send settles.
    refetchOnWindowFocus: false,
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
    onMutate: () => qc.cancelQueries({ queryKey: key, exact: true }),
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
      void qc.invalidateQueries({ queryKey: ['profile'], exact: true }) // questions left
    },
  })
}

export type ContentField = 'summary' | 'notes'

/** Save the summary or the notes (PRO-06). `baseHash` = hash of the text the edit started from:
 *  the API answers 409 `content_changed` when someone saved in the meantime. Not optimistic. */
export function useEditContent(meetingId: string) {
  const fetchApi = useFetchApi()
  const qc = useQueryClient()
  return useMutation({
    mutationKey: [...DETAIL_EDIT, 'content'],
    mutationFn: (v: { field: ContentField; content: string; baseHash: string }) =>
      apiJson<{ field: ContentField; content: string; contentHash: string }>(fetchApi, `/meetings/${enc(meetingId)}/content`, {
        method: 'PATCH',
        body: v,
      }),
    onSuccess: (r) =>
      qc.setQueryData<Meeting>(detailKeys.meeting(meetingId), (m) => (m ? { ...m, [r.field]: r.content } : m)),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: detailKeys.meeting(meetingId), exact: true })
      void qc.invalidateQueries({ queryKey: ['meeting', meetingId, 'versions'] })
    },
  })
}

// --- version history (PRO-06, part 6b) -----------------------------------------------------------

export const historyKeys = {
  list: (id: string, field: ContentField) => ['meeting', id, 'versions', field] as const,
  one: (id: string, versionId: string) => ['meeting', id, 'version', versionId] as const,
}

/** Newest first, without the text (viewer or above). */
export function useVersions(meetingId: string, field: ContentField, enabled: boolean) {
  const fetchApi = useFetchApi()
  return useQuery({
    queryKey: historyKeys.list(meetingId, field),
    enabled,
    queryFn: async () => normalizeVersions(await apiJson<unknown>(fetchApi, `/meetings/${enc(meetingId)}/content-versions?field=${enc(field)}`)),
  })
}

/** One version's text. A version never changes, so it is fetched once. */
export function useVersion(meetingId: string, versionId: string | null) {
  const fetchApi = useFetchApi()
  return useQuery({
    queryKey: historyKeys.one(meetingId, versionId ?? ''),
    enabled: versionId !== null,
    staleTime: Infinity,
    queryFn: async () => {
      const v = normalizeVersion(await apiJson<unknown>(fetchApi, `/meetings/${enc(meetingId)}/content-versions/${enc(versionId ?? '')}`))
      if (!v) throw new Error('malformed version')
      return v
    },
  })
}

/** Make a version current again (editor+). `baseHash` = hash of the text shown now (409 if it changed). */
export function useRestoreVersion(meetingId: string) {
  const fetchApi = useFetchApi()
  const qc = useQueryClient()
  return useMutation({
    mutationKey: [...DETAIL_EDIT, 'restore'],
    mutationFn: (v: { versionId: string; baseHash: string }) =>
      apiJson<{ field: ContentField; content: string; contentHash: string }>(
        fetchApi,
        `/meetings/${enc(meetingId)}/content-versions/${enc(v.versionId)}/restore`,
        { method: 'POST', body: { baseHash: v.baseHash } },
      ),
    onSuccess: (r) => {
      qc.setQueryData<Meeting>(detailKeys.meeting(meetingId), (m) => (m ? { ...m, [r.field]: r.content } : m))
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: detailKeys.meeting(meetingId), exact: true })
      void qc.invalidateQueries({ queryKey: ['meeting', meetingId, 'versions'] })
    },
  })
}
