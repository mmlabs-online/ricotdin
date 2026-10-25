'use client'

import type { RefObject } from 'react'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import ReactMarkdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import { browserClient } from '@/lib/supabase/browser'
import { getAccessToken } from '@/lib/supabase/auth'
import { getMeetingRole, canEdit } from '@/lib/access/roles'
import { useAudioDurationFix } from '@/lib/audio/useAudioDurationFix'
import { formatModelLabel } from '@/lib/ai/modelLabel'
import {
  buildTranscript,
  transcriptFilename,
  transcriptMime,
  type TranscriptFormat,
} from '@/lib/transcript/export'
import ChatPanel from '@/components/ChatPanel'
import { audioState } from '@/lib/retention/policy'
import type {
  Meeting,
  MeetingStatus,
  TranscriptSegment,
  Todo,
  TodoStatus,
  CalendarSuggestion,
  Citation,
  FolderWithRole,
} from '@/types/database'

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_MS = 3_000
const IN_FLIGHT: MeetingStatus[] = ['pending', 'processing']

// ── State machine ─────────────────────────────────────────────────────────────

type PageData =
  | { tag: 'loading' }
  | { tag: 'not-found' }
  | { tag: 'error'; message: string }
  | { tag: 'inflight'; meeting: Meeting }
  | { tag: 'failed'; meeting: Meeting }
  | {
      tag: 'done'
      meeting: Meeting
      segments: TranscriptSegment[]
      todos: Todo[]
      calSugs: CalendarSuggestion[]
    }

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatMs(ms: number): string {
  const totalSecs = Math.floor(ms / 1000)
  const m = Math.floor(totalSecs / 60).toString().padStart(2, '0')
  const s = (totalSecs % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

function formatProposedAt(iso: string | null): string {
  if (!iso) return 'No time specified'
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    })
  } catch {
    return iso
  }
}

// ── Page component ────────────────────────────────────────────────────────────

export default function MeetingDetailPage() {
  const params = useParams()
  const meetingId = typeof params.id === 'string' ? params.id : ''

  const [data, setData]                         = useState<PageData>({ tag: 'loading' })
  const [todoStatuses, setTodoStatuses]         = useState<Record<string, TodoStatus>>({})
  const [dismissedIds, setDismissedIds]         = useState<Set<string>>(new Set())
  const [dismissedTodoIds, setDismissedTodoIds] = useState<Set<string>>(new Set())
  const [audioUrl, setAudioUrl]                 = useState<string | null>(null)
  const [hackAudioRender, setHackAudioRender]   = useState(false)
  const [highlightedSegIndex, setHighlightedSegIndex] = useState<number | null>(null)
  const [rerunning, setRerunning]               = useState(false)
  const [regenLoading, setRegenLoading]         = useState(false)
  const [regenError, setRegenError]             = useState<string | null>(null)
  const [reloadKey, setReloadKey]               = useState(0)
  const [chatOpen, setChatOpen]                 = useState(false)
  const [chatExpanded, setChatExpanded]         = useState(false)
  const [showScrollTop, setShowScrollTop]       = useState(false)

  // ── Current user + folder state ───────────────────────────────────────────
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [folders, setFolders] = useState<FolderWithRole[]>([])

  const audioRef = useRef<HTMLAudioElement>(null)
  const audioPath = data.tag === 'done' ? data.meeting.audio_path : null

  // Browser recordings are unseekable live-mode WebM. When the admin flag
  // `user_hack_audio_render` is on, force a full-stream scan so the scrub bar
  // covers the whole recording. No-op for already-seekable files (mp3/m4a).
  const { scanning: audioScanning } = useAudioDurationFix(audioRef, hackAudioRender, audioUrl)

  // ── Data loading with polling ───────────────────────────────────────────────

  useEffect(() => {
    if (!meetingId) return
    let cancelled = false
    const timers: ReturnType<typeof setTimeout>[] = []

    async function load() {
      try {
        const { data: meeting, error: meetErr } = await browserClient
          .from('meetings').select('*').eq('id', meetingId).maybeSingle()

        if (cancelled) return
        if (meetErr) { setData({ tag: 'error', message: meetErr.message }); return }
        if (!meeting) { setData({ tag: 'not-found' }); return }

        if (IN_FLIGHT.includes(meeting.status)) {
          setData({ tag: 'inflight', meeting })
          timers.push(setTimeout(() => void load(), POLL_MS))
          return
        }

        if (meeting.status === 'failed') {
          // Check whether the transcript was written before the failure.
          // If segments exist we can still show them alongside empty states for
          // summary/note (with re-generate buttons). If not, keep the FailedView.
          const { data: segData } = await browserClient
            .from('transcript_segments')
            .select('*')
            .eq('meeting_id', meetingId)
            .order('segment_index')
          if (cancelled) return
          const failedSegs = (segData ?? []) as TranscriptSegment[]
          if (failedSegs.length === 0) { setData({ tag: 'failed', meeting }); return }
          const [failTodoR, failCalR] = await Promise.all([
            browserClient.from('todos').select('*').eq('meeting_id', meetingId).order('created_at'),
            browserClient.from('calendar_suggestions').select('*').eq('meeting_id', meetingId).order('created_at'),
          ])
          if (cancelled) return
          const failTodos   = (failTodoR.data ?? []) as Todo[]
          const failCalSugs = (failCalR.data ?? []) as CalendarSuggestion[]
          setTodoStatuses(Object.fromEntries(failTodos.map((t) => [t.id, t.status])))
          setDismissedIds(new Set(failCalSugs.filter((c) => c.dismissed).map((c) => c.id)))
          setData({ tag: 'done', meeting, segments: failedSegs, todos: failTodos, calSugs: failCalSugs })
          return
        }

        const [segR, todoR, calR] = await Promise.all([
          browserClient.from('transcript_segments').select('*').eq('meeting_id', meetingId).order('segment_index'),
          browserClient.from('todos').select('*').eq('meeting_id', meetingId).order('created_at'),
          browserClient.from('calendar_suggestions').select('*').eq('meeting_id', meetingId).order('created_at'),
        ])

        if (cancelled) return
        const segments = (segR.data ?? []) as TranscriptSegment[]
        const todos    = (todoR.data ?? []) as Todo[]
        const calSugs  = (calR.data ?? []) as CalendarSuggestion[]

        setTodoStatuses(Object.fromEntries(todos.map((t) => [t.id, t.status])))
        setDismissedIds(new Set(calSugs.filter((c) => c.dismissed).map((c) => c.id)))
        setData({ tag: 'done', meeting, segments, todos, calSugs })
      } catch (err) {
        if (cancelled) return
        setData({ tag: 'error', message: err instanceof Error ? err.message : 'Failed to load meeting.' })
      }
    }

    void load()
    return () => { cancelled = true; timers.forEach(clearTimeout) }
  }, [meetingId, reloadKey])

  // ── Audio signed URL ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!audioPath || !meetingId) { setAudioUrl(null); return }
    let cancelled = false
    async function fetchUrl() {
      try {
        const token = await getAccessToken()
        if (!token) return
        const res = await fetch(`/api/audio-url/${meetingId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok || cancelled) return
        const body = (await res.json()) as { url?: string; hackAudioRender?: boolean }
        if (cancelled) return
        setHackAudioRender(body.hackAudioRender === true)
        if (body.url) setAudioUrl(body.url)
      } catch { /* non-fatal */ }
    }
    void fetchUrl()
    return () => { cancelled = true }
  }, [audioPath, meetingId])

  // ── Load current user + folders ───────────────────────────────────────────
  useEffect(() => {
    browserClient.auth.getUser().then(({ data }) => {
      setCurrentUserId(data.user?.id ?? null)
    })
    async function loadFolders() {
      const token = await getAccessToken()
      if (!token) return
      try {
        const res = await fetch('/api/folders', { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) return
        const json = (await res.json()) as { folders: FolderWithRole[] }
        setFolders(json.folders)
      } catch { /* non-fatal */ }
    }
    void loadFolders()
  }, [])

  // ── Scroll-to-top visibility ────────────────────────────────────────────────

  useEffect(() => {
    function onScroll() { setShowScrollTop(window.scrollY > 400) }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // ── Handlers ──────────────────────────────────────────────────────────────

  function seekTo(ms: number) {
    if (!audioRef.current) return
    audioRef.current.currentTime = ms / 1000
    audioRef.current.play().catch(() => undefined)
  }

  function scrollToSegment(segmentId: string | null, segments: TranscriptSegment[]) {
    if (!segmentId) return
    const seg = segments.find((s) => s.id === segmentId)
    if (!seg) return
    setHighlightedSegIndex(seg.segment_index)
    document.getElementById(`seg-${seg.segment_index}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setTimeout(() => setHighlightedSegIndex(null), 2_000)
  }

  function handleCitationClick(citation: Citation, segments: TranscriptSegment[]) {
    if (segments.length === 0) return
    const nearest = segments.reduce((best, seg) =>
      Math.abs(seg.start_ms - citation.start_ms) < Math.abs(best.start_ms - citation.start_ms) ? seg : best,
    )
    seekTo(citation.start_ms)
    scrollToSegment(nearest.id, segments)
  }

  async function toggleTodo(todoId: string, current: TodoStatus) {
    const next: TodoStatus = current === 'done' ? 'open' : 'done'
    setTodoStatuses((prev) => ({ ...prev, [todoId]: next }))
    try {
      const token = await getAccessToken()
      if (!token) return
      const res = await fetch(`/api/todos/${todoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: next }),
      })
      if (!res.ok) throw new Error('update failed')
    } catch {
      setTodoStatuses((prev) => ({ ...prev, [todoId]: current }))
    }
  }

  async function dismissCalSug(suggestionId: string) {
    setDismissedIds((prev) => new Set([...prev, suggestionId]))
    try {
      const token = await getAccessToken()
      if (!token) return
      const res = await fetch(`/api/calendar-suggestions/${suggestionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ dismissed: true }),
      })
      if (!res.ok) throw new Error('dismiss failed')
    } catch {
      setDismissedIds((prev) => { const s = new Set(prev); s.delete(suggestionId); return s })
    }
  }

  async function dismissTodo(todoId: string) {
    setDismissedTodoIds((prev) => new Set([...prev, todoId]))
    try {
      const token = await getAccessToken()
      if (!token) return
      const res = await fetch(`/api/todos/${todoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: 'dismissed' }),
      })
      if (!res.ok) throw new Error('dismiss failed')
    } catch {
      setDismissedTodoIds((prev) => { const s = new Set(prev); s.delete(todoId); return s })
    }
  }

  async function downloadIcs(suggestionId: string, title: string) {
    try {
      const token = await getAccessToken()
      if (!token) return
      const res = await fetch(`/api/calendar-suggestions/${suggestionId}/ics`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = (title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60) || 'event') + '.ics'
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch { /* silent */ }
  }

  async function regenerateAnalysis() {
    setRegenLoading(true)
    setRegenError(null)
    try {
      const token = await getAccessToken()
      if (!token) { setRegenLoading(false); return }
      const res = await fetch(`/api/meetings/${meetingId}/regenerate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = (await res.json()) as { ok?: boolean; summary?: string; notes?: string; error?: string }
      if (!res.ok) {
        setRegenError(body.error ?? 'Re-generation failed. Please try again.')
        return
      }
      setData((prev) =>
        prev.tag === 'done'
          ? {
              ...prev,
              meeting: {
                ...prev.meeting,
                status: 'done',
                error_message: null,
                summary: body.summary ?? null,
                notes: body.notes ?? null,
              },
            }
          : prev,
      )
    } catch {
      setRegenError('Re-generation failed. Please try again.')
    } finally {
      setRegenLoading(false)
    }
  }

  async function moveToFolder(newFolderId: string | null) {
    const token = await getAccessToken()
    if (!token) return
    // Optimistic update on the meeting embedded in page data
    setData((prev) => {
      if (prev.tag === 'done') return { ...prev, meeting: { ...prev.meeting, folder_id: newFolderId } }
      if (prev.tag === 'inflight') return { ...prev, meeting: { ...prev.meeting, folder_id: newFolderId } }
      if (prev.tag === 'failed') return { ...prev, meeting: { ...prev.meeting, folder_id: newFolderId } }
      return prev
    })
    try {
      const res = await fetch(`/api/meetings/${meetingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ folder_id: newFolderId }),
      })
      if (!res.ok) {
        // Revert — re-fetch the meeting
        const { data: m } = await browserClient.from('meetings').select('*').eq('id', meetingId).maybeSingle()
        if (m) {
          setData((prev) => {
            if (prev.tag === 'done') return { ...prev, meeting: m as Meeting }
            if (prev.tag === 'inflight') return { ...prev, meeting: m as Meeting }
            if (prev.tag === 'failed') return { ...prev, meeting: m as Meeting }
            return prev
          })
        }
      }
    } catch { /* silent — state already optimistically updated */ }
  }

  async function rerunProcessing() {
    setRerunning(true)
    try {
      const token = await getAccessToken()
      if (!token) return
      const res = await fetch(`/api/meetings/${meetingId}/process`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        setData((prev) =>
          prev.tag === 'failed'
            ? { tag: 'inflight', meeting: { ...prev.meeting, status: 'processing' } }
            : prev,
        )
        setReloadKey((k) => k + 1)
      }
    } catch { /* ignore */ } finally {
      setRerunning(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <Link
          href="/meetings"
          className="inline-flex items-center gap-1.5 text-xs text-b-fg/50 font-sans uppercase tracking-widest hover:text-b-terra transition-colors duration-300 mb-6"
        >
          ← All meetings
        </Link>

        {data.tag === 'loading'  && <SkeletonLoader />}
        {data.tag === 'not-found' && <NotFoundView />}
        {data.tag === 'error'    && <ErrorView message={data.message} />}
        {data.tag === 'inflight' && <ProcessingView meeting={data.meeting} />}
        {data.tag === 'failed'   && (
          <FailedView meeting={data.meeting} rerunning={rerunning} onRerun={rerunProcessing} />
        )}
        {data.tag === 'done'     && (
          <DoneView
            meeting={data.meeting}
            segments={data.segments}
            todos={data.todos}
            calSugs={data.calSugs}
            todoStatuses={todoStatuses}
            dismissedIds={dismissedIds}
            dismissedTodoIds={dismissedTodoIds}
            audioUrl={audioUrl}
            audioRef={audioRef}
            audioScanning={audioScanning}
            highlightedSegIndex={highlightedSegIndex}
            onToggleTodo={toggleTodo}
            onDismissTodo={dismissTodo}
            onDismissCalSug={dismissCalSug}
            onDownloadIcs={downloadIcs}
            onSeekTo={seekTo}
            onScrollToSegment={(segId) => scrollToSegment(segId, data.segments)}
            onCitationClick={(c) => handleCitationClick(c, data.segments)}
            regenLoading={regenLoading}
            regenError={regenError}
            onRegenerate={regenerateAnalysis}
            folders={folders}
            onMoveFolder={moveToFolder}
            currentUserId={currentUserId}
          />
        )}
      </div>

      {/* ── Scroll to top ──────────────────────────────────────────────────── */}
      <button
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        aria-label="Back to top"
        title="Back to top"
        className={[
          'fixed bottom-6 right-[88px] z-50 w-11 h-11 rounded-full bg-b-fg text-white',
          'flex items-center justify-center shadow-lg transition-all duration-300 hover:opacity-90',
          showScrollTop ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
        ].join(' ')}
      >
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-5 h-5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />
        </svg>
      </button>

      {/* ── Floating chat ─────────────────────────────────────────────────── */}
      {data.tag === 'done' && (
        <>
          {/* Panel */}
          <div
            className={[
              'fixed bottom-[88px] right-6 z-50',
              'bg-white rounded-3xl border border-b-border overflow-hidden flex flex-col',
              'shadow-2xl transition-all duration-300 origin-bottom-right',
              chatExpanded ? 'w-[680px]' : 'w-80 sm:w-96',
              chatOpen
                ? 'opacity-100 scale-100 pointer-events-auto'
                : 'opacity-0 scale-95 pointer-events-none',
            ].join(' ')}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-b-border bg-b-clay/50 flex-shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-b-fg/10 flex items-center justify-center flex-shrink-0">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 text-b-fg/70">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
                  </svg>
                </div>
                <div>
                  <p className="font-sans font-semibold text-sm text-b-fg leading-tight">Ask about this meeting</p>
                  <p className="text-xs text-b-fg/40 font-sans">AI-powered Q&amp;A</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {/* Expand / collapse */}
                <button
                  onClick={() => setChatExpanded((prev) => !prev)}
                  className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-b-clay transition-colors text-b-fg/40 hover:text-b-fg"
                  aria-label={chatExpanded ? 'Collapse chat' : 'Expand chat'}
                  title={chatExpanded ? 'Collapse' : 'Expand'}
                >
                  {chatExpanded ? (
                    /* arrows-pointing-in (collapse) */
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9 3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25" />
                    </svg>
                  ) : (
                    /* arrows-pointing-out (expand) */
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                    </svg>
                  )}
                </button>
                {/* Close */}
                <button
                  onClick={() => { setChatOpen(false); setChatExpanded(false) }}
                  className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-b-clay transition-colors text-b-fg/40 hover:text-b-fg"
                  aria-label="Close chat"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Chat panel body — mounted only while open so API loads on open */}
            <div className="px-4 pb-4 pt-3">
              {chatOpen && (
                <ChatPanel
                  meetingId={data.meeting.id}
                  onCitationClick={(c) => handleCitationClick(c, data.segments)}
                  height={chatExpanded ? 640 : 440}
                />
              )}
            </div>
          </div>

          {/* Chat toggle button */}
          <button
            onClick={() => setChatOpen((prev) => !prev)}
            title={chatOpen ? 'Close chat' : 'Ask about this meeting'}
            aria-label={chatOpen ? 'Close chat' : 'Ask about this meeting'}
            className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-b-fg text-white flex items-center justify-center shadow-xl transition-all duration-300 hover:opacity-90"
          >
            {chatOpen ? (
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
              </svg>
            )}
          </button>
        </>
      )}
    </>
  )
}

// ── Loading / error views ─────────────────────────────────────────────────────

function SkeletonLoader() {
  return (
    <div className="flex flex-col gap-3 mt-4">
      <div className="h-9 w-2/3 rounded-2xl bg-b-clay animate-pulse" />
      <div className="h-4 w-1/3 rounded-xl bg-b-clay animate-pulse" />
      <div className="mt-4 h-24 rounded-3xl bg-b-clay animate-pulse" />
      <div className="h-36 rounded-3xl bg-b-clay animate-pulse" />
      <div className="h-52 rounded-3xl bg-b-clay animate-pulse" />
    </div>
  )
}

function NotFoundView() {
  return (
    <div className="text-center py-20">
      <p className="font-serif text-2xl font-bold text-b-fg mb-2">Meeting not found</p>
      <p className="text-sm text-b-fg/50 font-sans mb-6">
        This meeting may have been deleted or you don&apos;t have access to it.
      </p>
      <Link href="/meetings" className="btn-primary">← Back to meetings</Link>
    </div>
  )
}

function ErrorView({ message }: { message: string }) {
  return (
    <div className="mt-4 bg-red-50 border border-red-200 rounded-3xl px-5 py-4 text-sm text-red-700">
      {message}
    </div>
  )
}

function ProcessingView({ meeting }: { meeting: Meeting }) {
  return (
    <div>
      <MeetingHeaderBase meeting={meeting} />
      <div className="card-botanical text-center py-10 mt-4">
        <div
          className="w-10 h-10 rounded-full border-2 border-b-border mx-auto mb-4"
          style={{ borderTopColor: 'rgb(var(--t-primary-rgb))', animation: 'spin 1s linear infinite' }}
        />
        <p className="font-serif text-lg font-semibold text-b-fg mb-1">
          {meeting.status === 'pending' ? 'Queued for processing…' : 'Processing recording…'}
        </p>
        <p className="text-sm text-b-fg/50 font-sans">
          Transcribing audio and extracting notes — typically 30–90 seconds.
        </p>
      </div>
    </div>
  )
}

function FailedView({ meeting, rerunning, onRerun }: { meeting: Meeting; rerunning: boolean; onRerun: () => void }) {
  const isQuotaBlocked = meeting.error_message?.startsWith('QUOTA_BLOCKED:') ?? false
  return (
    <div>
      <MeetingHeaderBase meeting={meeting} />
      {isQuotaBlocked ? (
        <div className="mt-4 bg-amber-50 border border-amber-200 rounded-3xl px-5 py-4 text-sm text-amber-800">
          <p className="font-semibold mb-1">Insufficient audio balance</p>
          <p className="mb-3 opacity-80">
            This recording could not be processed because your audio-minute balance was too low.
            Contact your admin to top up your balance, then re-run processing.
          </p>
          <button
            onClick={onRerun}
            disabled={rerunning}
            className="btn-primary"
            style={{ opacity: rerunning ? 0.65 : 1 }}
          >
            {rerunning ? 'Starting…' : '↻ Re-run processing'}
          </button>
        </div>
      ) : (
        <div className="mt-4 bg-red-50 border border-red-200 rounded-3xl px-5 py-4 text-sm text-red-700">
          <p className="font-semibold mb-1">Processing failed</p>
          {meeting.error_message && <p className="mb-3 opacity-80">{meeting.error_message}</p>}
          <button
            onClick={onRerun}
            disabled={rerunning}
            className="btn-primary"
            style={{ opacity: rerunning ? 0.65 : 1 }}
          >
            {rerunning ? 'Starting…' : '↻ Re-run processing'}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Done view ─────────────────────────────────────────────────────────────────

interface DoneViewProps {
  meeting: Meeting
  segments: TranscriptSegment[]
  todos: Todo[]
  calSugs: CalendarSuggestion[]
  todoStatuses: Record<string, TodoStatus>
  dismissedIds: Set<string>
  dismissedTodoIds: Set<string>
  audioUrl: string | null
  audioRef: RefObject<HTMLAudioElement | null>
  /** True while the render hack is scanning the stream to make it seekable. */
  audioScanning: boolean
  highlightedSegIndex: number | null
  onToggleTodo: (id: string, current: TodoStatus) => void
  onDismissTodo: (id: string) => void
  onDismissCalSug: (id: string) => void
  onDownloadIcs: (id: string, title: string) => void
  onSeekTo: (ms: number) => void
  onScrollToSegment: (segmentId: string | null) => void
  onCitationClick: (citation: Citation) => void
  regenLoading: boolean
  regenError: string | null
  onRegenerate: () => void
  folders: FolderWithRole[]
  onMoveFolder: (folderId: string | null) => void
  currentUserId: string | null
}

function DoneView({
  meeting, segments, todos, calSugs,
  todoStatuses, dismissedIds, dismissedTodoIds,
  audioUrl, audioRef, audioScanning, highlightedSegIndex,
  onToggleTodo, onDismissTodo, onDismissCalSug, onDownloadIcs, onSeekTo, onScrollToSegment, onCitationClick,
  regenLoading, regenError, onRegenerate,
  folders, onMoveFolder, currentUserId,
}: DoneViewProps) {
  const activeSugs  = calSugs.filter((c) => !dismissedIds.has(c.id))
  const activeTodos = todos.filter((t) => !dismissedTodoIds.has(t.id))

  // ── Role ──────────────────────────────────────────────────────────────────
  const myRole = currentUserId
    ? getMeetingRole({ user_id: meeting.user_id, folder_id: meeting.folder_id }, currentUserId, folders)
    : 'viewer'
  const canEditThis = canEdit(myRole)

  // Only owned + editor-accessible folders appear in the move dropdown
  const editableFolders = folders.filter((f) => f.myRole === 'owner' || f.myRole === 'editor')

  // ── Inline title editing ──────────────────────────────────────────────────
  const [localTitle, setLocalTitle]     = useState(meeting.title)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft]     = useState('')

  // ── Folder move ───────────────────────────────────────────────────────────
  const [showMoveFolder, setShowMoveFolder] = useState(false)
  const currentFolderName = meeting.folder_id
    ? (folders.find((f) => f.id === meeting.folder_id)?.name ?? null)
    : null

  function startTitleEdit() {
    setTitleDraft(localTitle)
    setEditingTitle(true)
  }

  async function saveTitleEdit() {
    const trimmed = titleDraft.trim()
    setEditingTitle(false)
    if (!trimmed || trimmed === localTitle) return
    const prev = localTitle
    setLocalTitle(trimmed)
    try {
      const token = await getAccessToken()
      if (!token) { setLocalTitle(prev); return }
      const res = await fetch(`/api/meetings/${meeting.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: trimmed }),
      })
      if (!res.ok) setLocalTitle(prev)
    } catch {
      setLocalTitle(prev)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Pipeline failure warning — shown when transcription succeeded but analysis failed */}
      {meeting.status === 'failed' && (
        <div className="bg-red-50 border border-red-200 rounded-3xl px-5 py-4 text-sm text-red-700">
          <p className="font-semibold mb-1">Analysis failed</p>
          {meeting.error_message && <p className="opacity-80 mb-1">{meeting.error_message}</p>}
          <p className="opacity-70">The transcript is available below. Use &ldquo;Re-generate&rdquo; to retry the analysis.</p>
        </div>
      )}

      {/* Header */}
      <div className="mb-2">
        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            maxLength={200}
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void saveTitleEdit() }
              if (e.key === 'Escape') { setEditingTitle(false) }
            }}
            onBlur={() => void saveTitleEdit()}
            className="font-serif text-3xl font-bold text-b-fg leading-snug bg-transparent border-b-2 border-b-primary outline-none w-full pb-1 mb-2"
          />
        ) : (
          <div className="group flex items-start gap-2 mb-2">
            <h1 className="font-serif text-3xl font-bold text-b-fg leading-snug">{localTitle}</h1>
            {canEditThis && (
            <button
              onClick={startTitleEdit}
              className="mt-2 flex-shrink-0 p-1.5 rounded-lg text-b-fg/30 hover:text-b-primary hover:bg-b-clay transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
              title="Rename meeting"
              aria-label="Rename meeting"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
              </svg>
            </button>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 text-sm text-b-fg/50 font-sans">
          <span>{formatDate(meeting.created_at)}</span>
          {meeting.duration_seconds != null && <><span>·</span><span>{formatDuration(meeting.duration_seconds)}</span></>}
          {meeting.language && <><span>·</span><span>{meeting.language.toUpperCase()}</span></>}
          <span>·</span><StatusBadge status={meeting.status} />
          {meeting.generation_provider && meeting.generation_model && (
            <ModelBadge provider={meeting.generation_provider} model={meeting.generation_model} />
          )}
        </div>

        {/* Folder row */}
        <div className="mt-2 flex items-center gap-2">
          {canEditThis && showMoveFolder ? (
            <>
              <select
                defaultValue={meeting.folder_id ?? ''}
                autoFocus
                onChange={(e) => {
                  const v = e.target.value
                  setShowMoveFolder(false)
                  onMoveFolder(v === '' ? null : v)
                }}
                className="rounded-xl border border-b-border bg-b-clay px-3 py-1.5 text-sm font-sans text-b-fg focus:outline-none focus:ring-2 focus:ring-b-primary/40 cursor-pointer"
              >
                <option value="">Uncategorized</option>
                {editableFolders.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
              <button
                onClick={() => setShowMoveFolder(false)}
                className="text-xs text-b-fg/40 hover:text-b-fg/60 transition-colors font-sans cursor-pointer bg-transparent border-0"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => { if (canEditThis) setShowMoveFolder(true) }}
              disabled={!canEditThis}
              className={[
                'inline-flex items-center gap-1.5 text-xs font-sans bg-transparent border-0 group',
                canEditThis
                  ? 'text-b-fg/40 hover:text-b-fg/70 transition-colors cursor-pointer'
                  : 'text-b-fg/30 cursor-default',
              ].join(' ')}
              title={canEditThis ? 'Move to folder' : undefined}
            >
              {currentFolderName ? (
                <><span className="text-b-primary/70">📁 {currentFolderName}</span>{canEditThis && <span className="opacity-0 group-hover:opacity-100 transition-opacity">· change</span>}</>
              ) : (
                <span className={canEditThis ? 'hover:text-b-fg/60' : ''}>
                  📁 Uncategorized{canEditThis ? ' · move to folder' : ''}
                </span>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Audio player */}
      {meeting.audio_path && (
        <SectionCard label="Recording">
          {audioUrl ? (
            <>
              <audio ref={audioRef} controls preload="metadata" src={audioUrl} className="w-full rounded-xl" />
              {audioScanning && (
                <p className="mt-2 text-xs text-b-fg/40 font-sans animate-pulse">
                  Preparing the timeline so you can jump to any moment…
                </p>
              )}
            </>
          ) : (
            <div className="h-11 rounded-xl bg-b-clay flex items-center justify-center text-sm text-b-fg/40 font-sans animate-pulse">
              Loading audio player…
            </div>
          )}
        </SectionCard>
      )}
      {audioState(meeting) === 'purged' && (
        <SectionCard label="Recording">
          <p className="text-sm text-b-fg/60 font-sans">
            Audio deleted (retention policy)
            {meeting.audio_purged_at && (
              <> on {new Date(meeting.audio_purged_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</>
            )}.
            The transcript, notes and to-dos are kept.
          </p>
        </SectionCard>
      )}

      {/* Summary */}
      <SectionCard label="Summary">
        {regenLoading ? (
          <div className="flex items-center gap-2.5 py-2">
            <div
              className="w-4 h-4 rounded-full border-2 border-b-border flex-shrink-0"
              style={{ borderTopColor: 'rgb(var(--t-primary-rgb))', animation: 'spin 1s linear infinite' }}
            />
            <span className="text-sm text-b-fg/50 font-sans">Generating…</span>
          </div>
        ) : meeting.summary ? (
          <p className="text-sm text-b-fg/80 font-sans leading-relaxed">{meeting.summary}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-b-fg/40 font-sans italic">No summary was generated.</p>
            {regenError && <p className="text-xs text-red-600 font-sans">{regenError}</p>}
            <button onClick={onRegenerate} className="btn-primary self-start">↻ Re-generate summary</button>
          </div>
        )}
      </SectionCard>

      {/* Meeting notes */}
      <SectionCard label="Meeting notes">
        {regenLoading ? (
          <div className="flex items-center gap-2.5 py-2">
            <div
              className="w-4 h-4 rounded-full border-2 border-b-border flex-shrink-0"
              style={{ borderTopColor: 'rgb(var(--t-primary-rgb))', animation: 'spin 1s linear infinite' }}
            />
            <span className="text-sm text-b-fg/50 font-sans">Generating…</span>
          </div>
        ) : meeting.notes && meeting.notes.trim() ? (
          <div className="md-body text-sm text-b-fg/80 font-sans">
            <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{meeting.notes.replace(/\\n/g, '\n')}</ReactMarkdown>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-b-fg/40 font-sans italic">No meeting note was generated.</p>
            {regenError && <p className="text-xs text-red-600 font-sans">{regenError}</p>}
            <button onClick={onRegenerate} className="btn-primary self-start">↻ Re-generate meeting note</button>
          </div>
        )}
      </SectionCard>

      {/* Action items */}
      <SectionCard label={`Action items${activeTodos.length > 0 ? ` · ${activeTodos.length}` : ''}`}>
        {activeTodos.length === 0 ? (
          <p className="text-sm text-b-fg/40 font-sans italic">
            {todos.length > 0 ? 'All action items have been dismissed.' : 'No action items were found in this meeting.'}
          </p>
        ) : (
          <ul className="divide-y divide-b-border/50">
            {activeTodos.map((todo) => {
              const status  = todoStatuses[todo.id] ?? todo.status
              const isDone  = status === 'done'
              const isPastDue = !isDone && !!todo.due_date && todo.due_date < new Date().toISOString().slice(0, 10)
              return (
                <li key={todo.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                  <label className={['flex items-start gap-3 flex-1 min-w-0', canEditThis ? 'cursor-pointer' : 'cursor-default'].join(' ')}>
                    <input
                      type="checkbox"
                      checked={isDone}
                      disabled={!canEditThis}
                      onChange={() => { if (canEditThis) onToggleTodo(todo.id, status) }}
                      className={['mt-0.5 flex-shrink-0 accent-b-primary', canEditThis ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'].join(' ')}
                    />
                    <span className="flex-1 min-w-0">
                      <span className={['text-sm font-sans', isDone ? 'line-through text-b-fg/30' : 'text-b-fg'].join(' ')}>
                        {todo.content}
                      </span>
                      <span className="block text-xs text-b-fg/40 mt-0.5 font-sans">
                        {todo.assignee && <><span className="text-b-fg/60">@{todo.assignee}</span>{' · '}</>}
                        {todo.due_date ? (
                          <span className={isPastDue ? 'text-amber-600 font-semibold' : ''}>
                            {isPastDue ? '⚠ ' : ''}Due {todo.due_date}
                          </span>
                        ) : (
                          <span>No due date</span>
                        )}
                      </span>
                    </span>
                  </label>
                  <div className="flex-shrink-0 flex flex-col gap-1.5 items-end">
                    {todo.source_segment_id && (
                      <button
                        onClick={() => onScrollToSegment(todo.source_segment_id)}
                        className="text-xs px-2.5 py-1 rounded-full border border-b-border text-b-primary bg-transparent cursor-pointer hover:bg-b-clay transition-colors font-sans"
                      >
                        ↗ source
                      </button>
                    )}
                    {canEditThis && (
                      <button
                        onClick={() => onDismissTodo(todo.id)}
                        className="text-xs px-2.5 py-1 rounded-full border border-b-border text-b-fg/40 bg-transparent cursor-pointer hover:bg-b-clay transition-colors font-sans"
                      >
                        Dismiss
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </SectionCard>

      {/* Calendar suggestions */}
      {activeSugs.length > 0 && (
        <SectionCard label={`Events mentioned · ${activeSugs.length}`}>
          <p className="text-xs text-b-fg/40 font-sans mb-3 italic">
            Auto-detected from transcript. Download a .ics file to add to your calendar — no automatic syncing.
          </p>
          <ul className="divide-y divide-b-border/50">
            {activeSugs.map((sug) => (
              <li key={sug.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                <div className="flex-1 min-w-0">
                  <span className="font-sans font-semibold text-sm text-b-fg">{sug.title}</span>
                  <span className="block text-xs text-b-fg/50 mt-0.5 font-sans">{formatProposedAt(sug.proposed_at)}</span>
                  {sug.raw_mention && (
                    <span className="block text-xs text-b-fg/35 mt-0.5 font-sans italic">
                      &ldquo;{sug.raw_mention}&rdquo;
                    </span>
                  )}
                </div>
                <div className="flex-shrink-0 flex flex-col gap-1.5 items-end">
                  {sug.proposed_at ? (
                    <button
                      onClick={() => onDownloadIcs(sug.id, sug.title)}
                      className="text-xs px-2.5 py-1 rounded-full border border-b-primary text-b-primary bg-transparent cursor-pointer hover:bg-b-primary hover:text-white transition-colors font-sans"
                    >
                      ↓ .ics
                    </button>
                  ) : (
                    <span className="text-xs px-2.5 py-1 rounded-full border border-b-border text-b-fg/25 font-sans cursor-not-allowed">
                      + Calendar
                    </span>
                  )}
                  {canEditThis && (
                    <button
                      onClick={() => onDismissCalSug(sug.id)}
                      className="text-xs px-2.5 py-1 rounded-full border border-b-border text-b-fg/40 bg-transparent cursor-pointer hover:bg-b-clay transition-colors font-sans"
                    >
                      Dismiss
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {/* Transcript */}
      <SectionCard
        label={`Transcript${segments.length > 0 ? ` · ${segments.length} segments` : ''}`}
        action={segments.length > 0 ? <TranscriptExportButton meeting={meeting} segments={segments} /> : undefined}
      >
        {segments.length === 0 ? (
          <p className="text-sm text-b-fg/40 font-sans italic">No transcript is available for this meeting.</p>
        ) : (
          <TranscriptView
            segments={segments}
            highlightedSegIndex={highlightedSegIndex}
            onSeekTo={onSeekTo}
            canSeek={audioState(meeting) === 'available'}
          />
        )}
      </SectionCard>
    </div>
  )
}

// ── Transcript view ───────────────────────────────────────────────────────────

const SPEAKER_COLORS = ['#2D3A31', '#8C9A84', '#C27B66', '#DCCFC2', '#b45309', '#7c3aed']

function TranscriptView({
  segments, highlightedSegIndex, onSeekTo, canSeek,
}: {
  segments: TranscriptSegment[]
  highlightedSegIndex: number | null
  onSeekTo: (ms: number) => void
  /** false when there is no audio (e.g. purged by retention) — timestamps render as plain text. */
  canSeek: boolean
}) {
  // ── Group consecutive same-speaker turns ──────────────────────────────────
  type Group = { speaker: string; segs: TranscriptSegment[] }
  const groups: Group[] = []
  for (const seg of segments) {
    const speaker = seg.speaker ?? 'Speaker'
    const last = groups[groups.length - 1]
    if (last?.speaker === speaker) last.segs.push(seg)
    else groups.push({ speaker, segs: [seg] })
  }

  // Stable per-speaker color (first-seen order)
  const colorMap = new Map<string, string>()
  let ci = 0
  for (const { speaker } of groups) {
    if (!colorMap.has(speaker)) { colorMap.set(speaker, SPEAKER_COLORS[ci % SPEAKER_COLORS.length]); ci++ }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Turn blocks */}
      {groups.map((group, gi) => (
        <div key={gi}>
          <div className="mb-2">
            <span
              className="text-xs font-bold uppercase tracking-widest font-sans"
              style={{ color: colorMap.get(group.speaker) ?? '#8C9A84' }}
            >
              {group.speaker}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            {group.segs.map((seg) => {
              const isHighlighted = highlightedSegIndex === seg.segment_index
              return (
                <div
                  key={seg.id}
                  id={`seg-${seg.segment_index}`}
                  className={[
                    'flex gap-3 px-3 py-2 rounded-xl transition-all duration-500',
                    isHighlighted ? 'bg-amber-50 border-l-2 border-amber-400' : 'hover:bg-b-clay/40',
                  ].join(' ')}
                >
                  <div className="flex-shrink-0 flex flex-col items-end gap-0.5">
                    {canSeek ? (
                      <button
                        onClick={() => onSeekTo(seg.start_ms)}
                        className="text-xs font-mono text-b-fg/40 bg-transparent border border-b-border rounded-lg px-1.5 py-0.5 cursor-pointer hover:text-b-primary hover:border-b-primary transition-colors whitespace-nowrap"
                        title="Seek to this turn"
                      >
                        {formatMs(seg.start_ms)}–{formatMs(seg.end_ms)}
                      </button>
                    ) : (
                      <span className="text-xs font-mono text-b-fg/40 border border-b-border rounded-lg px-1.5 py-0.5 whitespace-nowrap">
                        {formatMs(seg.start_ms)}–{formatMs(seg.end_ms)}
                      </span>
                    )}
                    {seg.confidence != null && (
                      <span className="text-[10px] font-mono text-b-fg/25 leading-none">
                        {Math.round(seg.confidence * 100)}%
                      </span>
                    )}
                  </div>
                  <span className="flex-1 text-sm text-b-fg/80 font-sans leading-relaxed">{seg.text}</span>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function SectionCard({ label, action, children }: { label: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="card-botanical">
      <div className="flex items-center justify-between gap-3">
        <div className="section-label">{label}</div>
        {action && <div className="flex-shrink-0">{action}</div>}
      </div>
      {children}
    </div>
  )
}

// ── Transcript export ───────────────────────────────────────────────────────

const EXPORT_FORMATS: { value: TranscriptFormat; label: string }[] = [
  { value: 'txt', label: 'Plain text (.txt)' },
  { value: 'md', label: 'Markdown (.md)' },
  { value: 'srt', label: 'Subtitles (.srt)' },
]

function TranscriptExportButton({
  meeting, segments,
}: {
  meeting: Meeting
  segments: TranscriptSegment[]
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  function download(format: TranscriptFormat) {
    setOpen(false)
    const text = buildTranscript(
      { title: meeting.title, created_at: meeting.created_at },
      segments,
      format,
    )
    const blob = new Blob([text], { type: transcriptMime(format) })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = transcriptFilename(meeting.title, format)
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border border-b-border text-b-fg/60 bg-transparent cursor-pointer hover:text-b-primary hover:border-b-primary transition-colors font-sans"
        title="Export transcript"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-3.5 h-3.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
        </svg>
        Export
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1.5 z-20 w-48 rounded-2xl border border-b-border bg-white shadow-lg overflow-hidden py-1"
        >
          {EXPORT_FORMATS.map((f) => (
            <button
              key={f.value}
              role="menuitem"
              onClick={() => download(f.value)}
              className="w-full text-left px-4 py-2 text-sm font-sans text-b-fg/80 hover:bg-b-clay transition-colors cursor-pointer bg-transparent border-0"
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function MeetingHeaderBase({ meeting }: { meeting: Meeting }) {
  return (
    <div className="mb-4">
      <h1 className="font-serif text-2xl font-bold text-b-fg mb-2">{meeting.title}</h1>
      <div className="flex flex-wrap items-center gap-2 text-sm text-b-fg/50 font-sans">
        <span>{formatDate(meeting.created_at)}</span>
        {meeting.duration_seconds != null && <><span>·</span><span>{formatDuration(meeting.duration_seconds)}</span></>}
        <span>·</span><StatusBadge status={meeting.status} />
        {meeting.generation_provider && meeting.generation_model && (
          <ModelBadge provider={meeting.generation_provider} model={meeting.generation_model} />
        )}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: MeetingStatus }) {
  const cls: Record<MeetingStatus, string> = {
    pending:    'badge-pending',
    processing: 'badge-processing',
    done:       'badge-done',
    failed:     'badge-failed',
  }
  return <span className={cls[status]}>{status}</span>
}

/** Badge showing which AI model generated the meeting note. Renders nothing if unset. */
function ModelBadge({ provider, model }: { provider: string | null; model: string | null }) {
  if (!provider || !model) return null
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-b-border px-2 py-0.5 text-xs font-medium text-b-fg/60"
      title={`Generated with ${provider}:${model}`}
    >
      <span aria-hidden="true">✨</span>
      {formatModelLabel(provider, model)}
    </span>
  )
}
