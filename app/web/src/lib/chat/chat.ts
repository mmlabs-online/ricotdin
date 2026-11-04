// Chat messages from the API (ARC-13b: RAG-01..03; ARC-13c reuses it for the Chat page). Pure.
// Answers and citations are untrusted (§0.8): only well-formed citations are kept, and the
// answer text is rendered without links or images (lib/markdown.ts).
import { ApiError } from '../../api/errors'

export const MAX_QUESTION = 4000 // the API limit (chat.py)

export interface Citation {
  chunkId: string
  meetingId: string
  startMs: number
  endMs: number
}
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  citations: Citation[]
  createdAt: string
}

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null)
const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

function citations(v: unknown): Citation[] {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  const out: Citation[] = []
  for (const item of v) {
    const c = obj(item)
    if (!c) continue
    const { chunk_id, meeting_id, start_ms, end_ms } = c
    if (typeof chunk_id !== 'string' || !chunk_id || typeof meeting_id !== 'string' || !meeting_id) continue
    if (!time(start_ms) || !time(end_ms) || seen.has(chunk_id)) continue
    seen.add(chunk_id)
    out.push({ chunkId: chunk_id, meetingId: meeting_id, startMs: start_ms, endMs: end_ms })
  }
  return out
}

export function normalizeMessage(v: unknown): ChatMessage | null {
  const m = obj(v)
  if (!m) return null
  const { id, role, content, created_at } = m
  if (typeof id !== 'string' || !id || (role !== 'user' && role !== 'assistant') || typeof content !== 'string') return null
  return {
    id,
    role,
    content,
    citations: role === 'assistant' ? citations(m.citations) : [],
    createdAt: typeof created_at === 'string' ? created_at : '',
  }
}

/** `GET /chat` → the latest session of a scope. */
export function normalizeChat(v: unknown): { sessionId: string | null; messages: ChatMessage[] } {
  const body = obj(v)
  if (!body || typeof body.sessionId !== 'string' || !Array.isArray(body.messages)) return { sessionId: null, messages: [] }
  return {
    sessionId: body.sessionId,
    messages: body.messages.map(normalizeMessage).filter((m): m is ChatMessage => m !== null),
  }
}

export function questionProblem(text: string): 'empty' | 'tooLong' | null {
  const q = text.trim()
  if (!q) return 'empty'
  return q.length > MAX_QUESTION ? 'tooLong' : null
}

export function chatErrorKey(err: unknown): string {
  if (!(err instanceof ApiError)) return 'chat.errors.generic'
  if (err.status === 0) return 'chat.errors.network'
  if (err.status === 402) return 'chat.errors.noQuota'
  if (err.status === 429) return 'chat.errors.rateLimited'
  if (err.status === 413) return 'chat.errors.tooLong'
  if (err.status === 403 || err.status === 404) return 'chat.errors.forbidden'
  return 'chat.errors.generic'
}
