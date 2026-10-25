'use client'

import { useState, useEffect, useRef } from 'react'
import { getAccessToken } from '@/lib/supabase/auth'
import type { ChatMessage, Citation } from '@/types/database'

interface Props {
  meetingId?:    string | null
  folderId?:     string | null
  folderName?:   string | null
  /** For folder-scoped panels: map of meeting_id → title for citation labels. */
  meetingTitles?: Record<string, string>
  initialSessionId?: string | null
  onCitationClick?: (citation: Citation) => void
  height?: number
}

export default function ChatPanel({
  meetingId    = null,
  folderId     = null,
  folderName   = null,
  meetingTitles,
  initialSessionId = null,
  onCitationClick,
  height = 440,
}: Props) {
  const [messages, setMessages]             = useState<ChatMessage[]>([])
  const [sessionId, setSessionId]           = useState<string | null>(initialSessionId)
  const [input, setInput]                   = useState('')
  const [loading, setLoading]               = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [error, setError]                   = useState<string | null>(null)
  const [blockedAgent, setBlockedAgent]     = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Load the most recent session + messages for this scope
  useEffect(() => {
    // Load when either meetingId or folderId is provided
    const scopeParam = meetingId
      ? `meetingId=${encodeURIComponent(meetingId)}`
      : folderId
        ? `folderId=${encodeURIComponent(folderId)}`
        : null

    if (!scopeParam) return

    let cancelled = false
    async function loadHistory() {
      setHistoryLoading(true)
      try {
        const token = await getAccessToken()
        if (!token || cancelled) return
        const res = await fetch(`/api/chat?${scopeParam}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok || cancelled) return
        const body = (await res.json()) as { sessionId: string | null; messages: ChatMessage[] }
        if (cancelled) return
        if (body.sessionId) setSessionId(body.sessionId)
        setMessages(body.messages)
      } catch { /* non-fatal */ } finally {
        if (!cancelled) setHistoryLoading(false)
      }
    }
    void loadHistory()
    return () => { cancelled = true }
  }, [meetingId, folderId]) // eslint-disable-line react-hooks/set-state-in-effect

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  async function send() {
    if (!input.trim() || loading) return
    const text = input.trim()
    setInput('')
    setError(null)
    setLoading(true)

    const optimisticId = `opt-${Date.now()}`
    const optimistic: ChatMessage = {
      id:         optimisticId,
      session_id: sessionId ?? '',
      role:       'user',
      content:    text,
      citations:  [],
      created_at: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, optimistic])

    try {
      const token = await getAccessToken()
      if (!token) { setError('Not signed in.'); return }

      const body: Record<string, unknown> = { message: text, sessionId }
      if (meetingId) body.meetingId = meetingId
      if (folderId)  body.folderId  = folderId

      const res = await fetch('/api/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify(body),
      })

      const data = (await res.json()) as {
        sessionId?:        string
        message?:          ChatMessage
        error?:            string
        blocked?:          boolean
        reason?:           string
        remaining_queries?: number
      }

      if (res.status === 402 && data.blocked && data.reason === 'insufficient_agent_balance') {
        setBlockedAgent(true)
        setMessages((prev) => prev.filter((m) => m.id !== optimisticId))
        return
      }

      if (!res.ok) throw new Error(data.error ?? 'Chat request failed.')
      if (data.sessionId) setSessionId(data.sessionId)
      if (data.message)   setMessages((prev) => [...prev, data.message!])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId))
    } finally {
      setLoading(false)
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
  }

  // ── Empty state text ───────────────────────────────────────────────────────
  function emptyPlaceholder() {
    if (folderName)  return `Ask anything about meetings in "${folderName}".`
    if (meetingId)   return 'Ask anything about this meeting transcript.'
    return 'Ask anything about your meetings.'
  }

  // ── Scope badge ────────────────────────────────────────────────────────────
  function scopeBadge() {
    if (folderName) {
      return (
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-b-clay border border-b-border text-xs font-sans text-b-fg/60 mb-3 self-start">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="text-b-primary">
            <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l1.7 1.7H19.5A1.5 1.5 0 0 1 21 9.2v8.3A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10Z" fill="currentColor" opacity="0.6"/>
          </svg>
          Asking within <strong className="text-b-fg/80 font-semibold">{folderName}</strong>
        </div>
      )
    }
    return null
  }

  return (
    <div className="flex flex-col" style={{ height }}>
      {/* Scope badge (folder only) */}
      {scopeBadge()}

      {/* Thread */}
      <div className="flex-1 overflow-y-auto flex flex-col gap-3 pb-2 pr-1">
        {historyLoading && (
          <div className="flex items-center justify-center gap-2 mt-12">
            <div
              className="w-4 h-4 rounded-full border-2 border-b-border"
              style={{ borderTopColor: '#8C9A84', animation: 'spin 1s linear infinite' }}
            />
            <span className="text-sm text-b-fg/40 font-sans">Loading…</span>
          </div>
        )}
        {!historyLoading && messages.length === 0 && !loading && (
          <p className="text-sm text-b-fg/40 font-sans italic text-center mt-12">
            {emptyPlaceholder()}
          </p>
        )}

        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            meetingTitles={meetingTitles}
            onCitationClick={onCitationClick}
          />
        ))}

        {loading && (
          <div className="flex items-start">
            <div className="max-w-[82%] px-4 py-3 rounded-3xl rounded-bl-md bg-b-clay text-b-fg/50 text-sm font-sans italic">
              Thinking…
            </div>
          </div>
        )}

        {error && (
          <p className="text-sm text-red-600 font-sans px-1">{error}</p>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Blocked notice */}
      {blockedAgent && (
        <div className="px-4 py-3 rounded-2xl bg-amber-50 border border-amber-200 text-amber-800 text-sm font-sans mt-2">
          You have used all your agent queries. Contact your admin for more.
        </div>
      )}

      {/* Input row */}
      <div className="flex gap-2 items-end pt-3 border-t border-b-border">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Ask a question… (Enter to send, Shift+Enter for newline)"
          rows={2}
          disabled={loading || blockedAgent}
          className="flex-1 px-4 py-2.5 rounded-2xl bg-b-clay border border-b-border text-b-fg text-sm font-sans
                     placeholder:text-b-secondary outline-none resize-none transition-all duration-300
                     focus:border-b-primary disabled:opacity-50 leading-relaxed"
        />
        <button
          onClick={() => void send()}
          disabled={loading || !input.trim() || blockedAgent}
          className="flex-shrink-0 px-5 py-2.5 rounded-full bg-b-fg text-white text-sm font-semibold uppercase tracking-widest
                     border-0 cursor-pointer transition-all duration-300 hover:opacity-90
                     disabled:opacity-40 disabled:cursor-default"
        >
          Send
        </button>
      </div>
    </div>
  )
}

// ── Message bubble ─────────────────────────────────────────────────────────────

function formatMs(ms: number): string {
  const totalSecs = Math.floor(ms / 1000)
  const m = Math.floor(totalSecs / 60).toString().padStart(2, '0')
  const s = (totalSecs % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

function citationLabel(c: Citation, meetingTitles?: Record<string, string>): string {
  const ts = formatMs(c.start_ms)
  const title = meetingTitles?.[c.meeting_id]
  return title ? `${title} @ ${ts}` : ts
}

function MessageBubble({
  message, meetingTitles, onCitationClick,
}: {
  message: ChatMessage
  meetingTitles?: Record<string, string>
  onCitationClick?: (c: Citation) => void
}) {
  const isUser = message.role === 'user'
  return (
    <div className={['flex flex-col', isUser ? 'items-end' : 'items-start'].join(' ')}>
      <div
        className={[
          'max-w-[82%] px-4 py-3 text-sm font-sans leading-relaxed whitespace-pre-wrap break-words',
          isUser
            ? 'bg-b-fg text-white rounded-3xl rounded-br-md'
            : 'bg-b-clay text-b-fg rounded-3xl rounded-bl-md',
        ].join(' ')}
      >
        {message.content}
      </div>

      {!isUser && message.citations.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mt-1.5 pl-1">
          <span className="text-xs text-b-fg/30 font-sans">Sources:</span>
          {message.citations.map((c, i) => (
            <button
              key={i}
              onClick={() => onCitationClick?.(c)}
              title={`Jump to ${formatMs(c.start_ms)}`}
              className="text-xs font-mono px-2 py-0.5 rounded-lg border border-b-border bg-white text-b-primary
                         cursor-pointer hover:bg-b-clay hover:border-b-primary transition-colors duration-200"
            >
              {citationLabel(c, meetingTitles)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
