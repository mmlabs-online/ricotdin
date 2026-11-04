// Chat page data (ARC-13c: RAG-01..04): "all meetings" or one folder. The meeting chat lives in
// api/meetingDetail.ts.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useFetchApi } from '../auth/AuthProvider'
import { normalizeChat, normalizeMessage, type ChatMessage, type ChatScope } from '../lib/chat/chat'
import { apiJson } from './json'

export interface ScopeChat {
  sessionId: string | null
  messages: ChatMessage[]
}

const enc = encodeURIComponent
const scopeKey = (scope: ChatScope) => (scope.kind === 'folder' ? `folder:${scope.folderId}` : 'all')

/** `session`: a known session id; `'latest'`: the folder's latest session; `null`: a new chat. */
export type SessionRef = string | 'latest' | null

export const chatKey = (scope: ChatScope, session: SessionRef) => ['chat', scopeKey(scope), session ?? 'new'] as const

const EMPTY: ScopeChat = { sessionId: null, messages: [] }

export function useScopeChat(scope: ChatScope, session: SessionRef) {
  const fetchApi = useFetchApi()
  return useQuery({
    queryKey: chatKey(scope, session),
    // stored questions would duplicate the "sending" bubble if refetched while an answer is pending
    refetchOnWindowFocus: false,
    // a new chat (or "all meetings" without a stored session) has nothing to load
    initialData: session === null || (session === 'latest' && scope.kind !== 'folder') ? EMPTY : undefined,
    queryFn: async (): Promise<ScopeChat> => {
      if (session === null) return EMPTY
      if (session !== 'latest') return normalizeChat(await apiJson<unknown>(fetchApi, `/chat?sessionId=${enc(session)}`))
      if (scope.kind !== 'folder') return EMPTY // "all meetings" has no latest-session lookup (v1)
      return normalizeChat(await apiJson<unknown>(fetchApi, `/chat?folderId=${enc(scope.folderId)}`))
    },
  })
}

export function useAskScope(scope: ChatScope) {
  const fetchApi = useFetchApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ message, sessionId }: { message: string; sessionId: string | null; prior: ChatMessage[] }) =>
      apiJson<{ sessionId: unknown; message: unknown }>(fetchApi, '/chat', {
        method: 'POST',
        body: {
          message,
          ...(scope.kind === 'folder' ? { folderId: scope.folderId } : {}),
          ...(sessionId ? { sessionId } : {}),
        },
      }),
    onMutate: () => qc.cancelQueries({ queryKey: ['chat', scopeKey(scope)] }),
    onSuccess: (res, { message, prior }) => {
      if (typeof res.sessionId !== 'string') return
      const reply = normalizeMessage(res.message)
      const question: ChatMessage = { id: `local-${Date.now()}`, role: 'user', content: message, citations: [], createdAt: '' }
      const key = chatKey(scope, res.sessionId)
      qc.setQueryData<ScopeChat>(key, { sessionId: res.sessionId, messages: [...prior, question, ...(reply ? [reply] : [])] })
      void qc.invalidateQueries({ queryKey: key, exact: true })
    },
  })
}
