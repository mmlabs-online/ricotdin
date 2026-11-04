import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/errors'
import { chatErrorKey, chatScope, normalizeChat, normalizeMessage, questionProblem, readStoredSession, MAX_QUESTION } from './chat'

const raw = (over: Record<string, unknown> = {}) => ({
  id: 'msg1',
  session_id: 's1',
  role: 'assistant',
  content: 'Answer',
  citations: [{ chunk_id: 'c1', meeting_id: 'm1', start_ms: 1000, end_ms: 2000 }],
  created_at: '2026-11-04T00:00:00Z',
  ...over,
})

describe('normalizeMessage', () => {
  it('keeps a well-formed message', () => {
    expect(normalizeMessage(raw())).toEqual({
      id: 'msg1',
      role: 'assistant',
      content: 'Answer',
      citations: [{ chunkId: 'c1', meetingId: 'm1', startMs: 1000, endMs: 2000 }],
      createdAt: '2026-11-04T00:00:00Z',
    })
  })

  it('drops messages with an unknown role or no text', () => {
    expect(normalizeMessage(raw({ role: 'system' }))).toBeNull()
    expect(normalizeMessage(raw({ content: 42 }))).toBeNull()
    expect(normalizeMessage(null)).toBeNull()
    expect(normalizeMessage(raw({ id: '' }))).toBeNull()
  })

  it('drops malformed citations and duplicates', () => {
    const msg = normalizeMessage(
      raw({
        citations: [
          { chunk_id: 'c1', meeting_id: 'm1', start_ms: 1000, end_ms: 2000 },
          { chunk_id: 'c1', meeting_id: 'm1', start_ms: 1000, end_ms: 2000 },
          { chunk_id: 'c2', meeting_id: 'm1', start_ms: 'x', end_ms: 1 },
          { chunk_id: 'c3', meeting_id: 'm1', start_ms: -5, end_ms: 1 },
          'junk',
        ],
      }),
    )
    expect(msg?.citations.map((c) => c.chunkId)).toEqual(['c1'])
  })

  it('a non-array citations field means none', () => {
    expect(normalizeMessage(raw({ citations: 'x' }))?.citations).toEqual([])
  })
})

describe('normalizeChat', () => {
  it('reads the GET /chat answer', () => {
    expect(normalizeChat({ sessionId: 's1', messages: [raw(), raw({ id: 'bad', role: 'x' })] })).toMatchObject({
      sessionId: 's1',
      messages: [{ id: 'msg1' }],
    })
  })

  it('anything else is an empty chat', () => {
    expect(normalizeChat(null)).toEqual({ sessionId: null, messages: [] })
    expect(normalizeChat({ sessionId: 5, messages: 'x' })).toEqual({ sessionId: null, messages: [] })
  })
})

describe('questionProblem', () => {
  it('empty or too long', () => {
    expect(questionProblem('   ')).toBe('empty')
    expect(questionProblem('a'.repeat(MAX_QUESTION + 1))).toBe('tooLong')
    expect(questionProblem(' ok ')).toBeNull()
  })
})

describe('chatErrorKey', () => {
  const e = (status: number, code = 'x') => new ApiError(status, code, '')
  it('maps API answers to message keys', () => {
    expect(chatErrorKey(e(402, 'insufficient_agent_balance'))).toBe('chat.errors.noQuota')
    expect(chatErrorKey(e(429))).toBe('chat.errors.rateLimited')
    expect(chatErrorKey(e(413))).toBe('chat.errors.tooLong')
    expect(chatErrorKey(e(403))).toBe('chat.errors.forbidden')
    expect(chatErrorKey(e(404))).toBe('chat.errors.forbidden')
    expect(chatErrorKey(e(0, 'network'))).toBe('chat.errors.network')
    expect(chatErrorKey(e(500))).toBe('chat.errors.generic')
  })
})

describe('chatScope', () => {
  it('a folder from ?folder=, else all meetings', () => {
    expect(chatScope('?folder=f1')).toEqual({ kind: 'folder', folderId: 'f1' })
    expect(chatScope('')).toEqual({ kind: 'all' })
    expect(chatScope('?folder=')).toEqual({ kind: 'all' })
    expect(chatScope('?folder=' + 'x'.repeat(100))).toEqual({ kind: 'all' })
    expect(chatScope('?folder=a/b')).toEqual({ kind: 'all' })
  })
})

describe('readStoredSession', () => {
  it('accepts only a uuid-shaped id', () => {
    expect(readStoredSession('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe('0f8fad5b-d9cb-469f-a165-70867728950e')
    expect(readStoredSession(null)).toBeNull()
    expect(readStoredSession('../x')).toBeNull()
  })
})
