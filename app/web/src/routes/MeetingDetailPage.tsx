// Meeting detail (ARC-13b, Make MeetingDetail): header + actions, processing state, player,
// summary / notes / to-dos / calendar / transcript tabs, and chat about this meeting.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Clock3, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useApiUrl, useAuth, useFetchApi } from '../auth/AuthProvider'
import { ApiError } from '../api/errors'
import {
  detailKeys,
  useAudioUrl,
  useDismissSuggestion,
  useMeeting,
  useMoveDetail,
  useProcess,
  useRegenerate,
  useRenameDetail,
  useSuggestions,
  useTodos,
  useTodoStatus,
  useTranscript,
} from '../api/meetingDetail'
import { useDeleteMeeting, useFolders, type Meeting } from '../api/meetings'
import { AudioPlayer, type AudioPlayerHandle } from '../components/AudioPlayer'
import { FullPageLoading } from '../components/FullPageLoading'
import { CalendarPanel, NotesPanel, SummaryPanel, TodosPanel, TranscriptPanel } from '../components/meeting/DetailPanels'
import { MeetingChat } from '../components/meeting/MeetingChat'
import { DeleteMeetingDialog } from '../components/meetings/DeleteMeetingDialog'
import { MoveDialog } from '../components/meetings/MoveDialog'
import { RowMenu, type MenuItem } from '../components/meetings/RowMenu'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { Status } from '../components/ui/Status'
import { canDelete, canMove, canRename, getMeetingRole } from '../lib/access/roles'
import type { Citation } from '../lib/chat/chat'
import { downloadBlob, downloadIcs } from '../lib/media/download'
import { meetingSeekPath, nearestSegment, parseSeekParam } from '../lib/media/seek'
import {
  actionErrorKey,
  audioState,
  canRegenerate,
  canReprocess,
  failureKind,
  modelLabel,
  visibleTodos,
  type CalendarSuggestion,
  type DetailAction,
  type TodoStatus,
} from '../lib/meetings/detail'
import { durationParts, statusKind } from '../lib/meetings/list'
import { displayText } from '../lib/text'
import { buildTranscript, transcriptFilename, transcriptMime, type TranscriptFormat, type TranscriptSegment } from '../lib/transcript/export'

const TABS = ['summary', 'notes', 'todos', 'calendar', 'transcript'] as const
type Tab = (typeof TABS)[number]
type Notice = { key: string; kind: 'error' | 'warning' | 'success' }
const AUDIO_RETRY_MS = 30_000

export function MeetingDetailPage() {
  const { t } = useTranslation()
  const { meetingId = '' } = useParams()
  const meeting = useMeeting(meetingId)
  if (meeting.isPending) return <FullPageLoading />
  if (meeting.isError) {
    const missing = meeting.error instanceof ApiError && [400, 403, 404].includes(meeting.error.status)
    return (
      <div className="detail-page">
        <BackLink />
        <div className="empty-state">
          <h1>{t(missing ? 'detail.notFound.title' : 'detail.loadError')}</h1>
          {missing ? <p>{t('detail.notFound.body')}</p> : <Button onClick={() => void meeting.refetch()}>{t('common.tryAgain')}</Button>}
        </div>
      </div>
    )
  }
  return <MeetingDetail key={meeting.data.id} meeting={meeting.data} />
}

function BackLink() {
  const { t } = useTranslation()
  return (
    <Link className="button button-ghost back-button" to="/meetings">
      <ArrowLeft size={16} aria-hidden="true" /> {t('page.meetingDetail.back')}
    </Link>
  )
}

function MeetingDetail({ meeting }: { meeting: Meeting }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const qc = useQueryClient()
  const fetchApi = useFetchApi()
  const apiUrl = useApiUrl()
  const { state } = useAuth()
  const me = state.status === 'signedIn' ? state.user.id : ''
  const id = meeting.id
  const title = displayText(meeting.title)

  useEffect(() => {
    document.title = `${title} · ${t('app.name')}`
  }, [title, t])

  const folders = useFolders()
  const folderList = folders.data ?? []
  const role = getMeetingRole(meeting, me, folderList)
  const canEdit = canRename(role)
  const done = meeting.status === 'done'
  const audio = audioState(meeting)
  const wantAudio = audio === 'available' && meeting.status !== 'pending'

  const transcript = useTranscript(id, done)
  const todos = useTodos(id, done)
  const suggestions = useSuggestions(id, done)
  const audioUrl = useAudioUrl(id, wantAudio)
  const segments = useMemo(() => transcript.data ?? [], [transcript.data])

  const todoStatus = useTodoStatus(id)
  const dismiss = useDismissSuggestion(id)
  const rename = useRenameDetail(id)
  const move = useMoveDetail(id)
  const regenerate = useRegenerate(id)
  const process = useProcess(id)
  const del = useDeleteMeeting()

  const [tab, setTab] = useState<Tab>(() => (parseSeekParam(location.search) !== null ? 'transcript' : 'summary'))
  const [activeSeg, setActiveSeg] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<'rename' | 'move' | 'delete' | 'regenerate' | 'reprocess' | null>(null)
  const player = useRef<AudioPlayerHandle>(null)
  const tabsId = useId()
  const fail = (action: DetailAction) => (err: unknown) => setNotice({ key: actionErrorKey(action, err), kind: 'error' })

  // Processing finished while the page was open: load the results.
  const prevStatus = useRef(meeting.status)
  useEffect(() => {
    if (prevStatus.current !== meeting.status && meeting.status === 'done') {
      for (const key of [detailKeys.transcript(id), detailKeys.todos(id), detailKeys.suggestions(id), detailKeys.chat(id)]) {
        void qc.invalidateQueries({ queryKey: key })
      }
    }
    prevStatus.current = meeting.status
  }, [meeting.status, id, qc])

  function seek(ms: number) {
    setTab('transcript')
    setActiveSeg(nearestSegment(segments, ms)?.id ?? null)
    player.current?.seekTo(ms)
  }

  // `?t=<seconds>` (a chat citation from another page): seek once the transcript and player are ready.
  const initialSeek = useRef(parseSeekParam(location.search))
  const audioSettled = !wantAudio || audioUrl.isSuccess || audioUrl.isError
  useEffect(() => {
    const ms = initialSeek.current
    if (ms === null || !transcript.isSuccess || !audioSettled) return
    initialSeek.current = null
    setActiveSeg(nearestSegment(segments, ms)?.id ?? null)
    player.current?.seekTo(ms)
  }, [transcript.isSuccess, audioSettled, segments])

  const lastAudioRetry = useRef(0)
  function audioFailed() {
    const now = Date.now()
    if (now - lastAudioRetry.current < AUDIO_RETRY_MS) return
    lastAudioRetry.current = now
    void audioUrl.refetch()
  }

  function onCitation(c: Citation) {
    if (c.meetingId === id) seek(c.startMs)
    else void navigate(meetingSeekPath(c.meetingId, c.startMs))
  }

  // Controls that disappear (a dismissed row) hand focus to their section heading.
  const focusAfter = useRef<string | null>(null)
  useEffect(() => {
    const sel = focusAfter.current
    if (!sel) return
    focusAfter.current = null
    document.querySelector<HTMLElement>(sel)?.focus()
  })

  function setTodo(todoId: string, status: TodoStatus) {
    if (status === 'dismissed') focusAfter.current = '#todos-title'
    todoStatus.mutate({ id: todoId, status }, { onError: fail('save') })
  }
  function dismissSuggestion(sid: string) {
    focusAfter.current = '#calendar-title'
    dismiss.mutate(sid, { onError: fail('save') })
  }
  function ics(s: CalendarSuggestion) {
    downloadIcs(fetchApi, s.id, s.title).catch(fail('ics'))
  }
  function exportTranscript(format: TranscriptFormat) {
    const body = buildTranscript(meeting, segments as TranscriptSegment[], format)
    downloadBlob(new Blob([body], { type: transcriptMime(format) }), transcriptFilename(meeting.title, format))
  }
  function runRegenerate() {
    setDialog(null)
    focusAfter.current = '[data-focus="regenerate"]'
    regenerate.mutate(undefined, {
      onSuccess: () => setNotice({ key: 'detail.regenerate.done', kind: 'success' }),
      onError: fail('regenerate'),
    })
  }
  function runProcess() {
    setDialog(null)
    focusAfter.current = '#detail-title'
    process.mutate(undefined, {
      onSuccess: () => setNotice({ key: 'detail.reprocess.started', kind: 'success' }),
      onError: fail('process'),
    })
  }

  const items: MenuItem[] = []
  if (canEdit) items.push({ key: 'rename', label: t('meetings.actions.rename'), onSelect: () => setDialog('rename') })
  if (canMove(role) && folders.isSuccess) items.push({ key: 'move', label: t('meetings.actions.move'), onSelect: () => setDialog('move') })
  if (canReprocess(meeting, role) && done) items.push({ key: 'reprocess', label: t('detail.reprocess.action'), onSelect: () => setDialog('reprocess') })
  if (segments.length > 0) {
    for (const f of ['txt', 'md', 'srt'] as const) {
      items.push({ key: `export-${f}`, label: t('detail.export', { format: f.toUpperCase() }), onSelect: () => exportTranscript(f) })
    }
  }
  if (canDelete(role)) items.push({ key: 'delete', label: t('meetings.actions.delete'), onSelect: () => setDialog('delete'), danger: true })

  const folderName = meeting.folder_id ? folderList.find((f) => f.id === meeting.folder_id)?.name : null
  const created = new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(meeting.created_at))
  const parts = durationParts(meeting.duration_seconds)
  const kind = statusKind(meeting.status)
  const openTodos = visibleTodos(todos.data ?? []).filter((x) => x.status === 'open').length
  const state3 = (q: { isPending: boolean; isError: boolean }) => (q.isPending ? 'pending' : q.isError ? 'error' : 'success') as 'pending' | 'error' | 'success'

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    const at = TABS.indexOf(tab)
    let next: number | null = null
    if (e.key === 'ArrowRight') next = (at + 1) % TABS.length
    else if (e.key === 'ArrowLeft') next = (at - 1 + TABS.length) % TABS.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = TABS.length - 1
    if (next === null) return
    e.preventDefault()
    const target = TABS[next] ?? 'summary'
    setTab(target)
    document.getElementById(`${tabsId}-tab-${target}`)?.focus()
  }

  return (
    <div className="detail-page">
      <BackLink />
      <div className="detail-head">
        <div>
          <span className="eyebrow">
            {folderName ? `${displayText(folderName)} · ` : ''}
            {created}
          </span>
          <h1 id="detail-title" tabIndex={-1} className="bidi-isolate">
            {title}
          </h1>
          <div className="detail-meta">
            <Status type={kind}>{meeting.status === 'pending' ? t('detail.status.pending') : t(`meetings.status.${kind}`)}</Status>
            {parts && (
              <span>
                <Clock3 size={14} aria-hidden="true" />
                {parts.hours > 0 ? t('meetings.duration.hm', { h: parts.hours, m: parts.minutes }) : t('meetings.duration.m', { m: parts.minutes })}
              </span>
            )}
            {meeting.source in { recorded: 1, uploaded: 1, video: 1 } && <span>{t(`meetings.source.${meeting.source}`)}</span>}
          </div>
        </div>
        {items.length > 0 && <RowMenu label={t('meetings.actions.more', { title })} items={items} />}
      </div>

      <p className="sr-only" role="status">
        {notice && notice.kind !== 'error' ? t(notice.key) : ''}
      </p>
      {notice && (
        <div className={`notice-banner ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : undefined}>
          <span>{t(notice.key)}</span>
          <Button variant="ghost" onClick={() => setNotice(null)} aria-label={t('common.dismiss')}>
            <X size={16} aria-hidden="true" />
          </Button>
        </div>
      )}

      {(meeting.status === 'pending' || meeting.status === 'processing') && (
        <div className="state-card">
          <LoaderCircle className="spin" size={20} aria-hidden="true" />
          <div>
            <strong>{t(meeting.status === 'pending' ? 'detail.state.pendingTitle' : 'detail.state.processingTitle')}</strong>
            <p>{t(meeting.status === 'pending' ? 'detail.state.pendingBody' : 'detail.state.processingBody')}</p>
          </div>
        </div>
      )}

      {meeting.status === 'failed' && (
        <div className="state-card danger">
          <div>
            <strong>{t(failureKind(meeting.error_message) === 'quota' ? 'detail.failed.quotaTitle' : 'detail.failed.title')}</strong>
            <p>{t(failureKind(meeting.error_message) === 'quota' ? 'detail.failed.quotaBody' : 'detail.failed.body')}</p>
            {failureKind(meeting.error_message) === 'failed' && meeting.error_message && (
              <p className="state-detail">{displayText(meeting.error_message)}</p>
            )}
          </div>
          {canReprocess(meeting, role) && (
            <Button variant="primary" onClick={runProcess} aria-disabled={process.isPending} aria-busy={process.isPending}>
              <RefreshCw size={15} aria-hidden="true" />
              {process.isPending ? t('detail.reprocess.busy') : t('detail.reprocess.action')}
            </Button>
          )}
        </div>
      )}

      {audio === 'purged' && <p className="audio-note">{t('detail.audio.purged')}</p>}
      {wantAudio && (
        <div className="audio-player">
          {audioUrl.isSuccess ? (
            <AudioPlayer
              ref={player}
              src={`${apiUrl}${audioUrl.data.url}`}
              hackAudioRender={audioUrl.data.hackAudioRender}
              fallbackSeconds={meeting.duration_seconds}
              label={t('detail.audio.label', { title })}
              onError={audioFailed}
            />
          ) : audioUrl.isError ? (
            <>
              <span>{t('detail.audio.error')}</span>
              <Button onClick={() => void audioUrl.refetch()}>{t('common.tryAgain')}</Button>
            </>
          ) : (
            <span>{t('player.loading')}</span>
          )}
        </div>
      )}

      {done && (
        <div className="detail-layout">
          <section className="detail-main">
            <div className="detail-tabs" role="tablist" aria-label={t('detail.tabsLabel')}>
              {TABS.map((id2) => (
                <button
                  key={id2}
                  type="button"
                  role="tab"
                  id={`${tabsId}-tab-${id2}`}
                  aria-selected={tab === id2}
                  aria-controls={`${tabsId}-panel`}
                  tabIndex={tab === id2 ? 0 : -1}
                  className={tab === id2 ? 'active' : ''}
                  onClick={() => setTab(id2)}
                  onKeyDown={onTabKey}
                >
                  {t(`detail.tabs.${id2}`)}
                  {id2 === 'todos' && openTodos > 0 && <span>{openTodos}</span>}
                </button>
              ))}
            </div>
            <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-tab-${tab}`} className="tab-content">
              {tab === 'summary' && (
                <SummaryPanel
                  summary={meeting.summary}
                  model={modelLabel(meeting.generation_provider, meeting.generation_model)}
                  regenerate={{ visible: canRegenerate(meeting, role), busy: regenerate.isPending, onClick: () => !regenerate.isPending && setDialog('regenerate') }}
                />
              )}
              {tab === 'notes' && <NotesPanel notes={meeting.notes} />}
              {tab === 'todos' && (
                <TodosPanel
                  todos={todos.data ?? []}
                  state={state3(todos)}
                  onRetry={() => void todos.refetch()}
                  segments={segments}
                  canEdit={canEdit}
                  onStatus={setTodo}
                  onSource={seek}
                />
              )}
              {tab === 'calendar' && (
                <CalendarPanel
                  suggestions={suggestions.data ?? []}
                  state={state3(suggestions)}
                  onRetry={() => void suggestions.refetch()}
                  segments={segments}
                  canEdit={canEdit}
                  onDismiss={dismissSuggestion}
                  onIcs={ics}
                  onSource={seek}
                />
              )}
              {tab === 'transcript' && (
                <TranscriptPanel
                  segments={segments}
                  state={state3(transcript)}
                  onRetry={() => void transcript.refetch()}
                  canSeek={audioUrl.isSuccess}
                  activeId={activeSeg}
                  onSeek={(s) => seek(s.start_ms)}
                />
              )}
            </div>
          </section>
          <MeetingChat meetingId={id} ready={done} onCitation={onCitation} />
        </div>
      )}

      {dialog === 'rename' && (
        <RenameDialog
          current={meeting.title}
          onClose={() => setDialog(null)}
          onSave={(next) => {
            setDialog(null)
            focusAfter.current = '#detail-title'
            if (next !== meeting.title) rename.mutate(next, { onError: fail('save') })
          }}
        />
      )}
      {dialog === 'move' && (
        <MoveDialog
          title={title}
          current={meeting.folder_id}
          folders={folderList}
          onClose={() => setDialog(null)}
          onMove={(folderId) => {
            setDialog(null)
            if (folderId !== meeting.folder_id) move.mutate(folderId, { onError: fail('save') })
          }}
        />
      )}
      {dialog === 'delete' && (
        <DeleteMeetingDialog
          title={title}
          busy={del.isPending}
          onClose={() => setDialog(null)}
          onConfirm={() =>
            del.mutate(id, {
              onSuccess: (r) => void navigate('/meetings', { state: { notice: r?.warning ? 'warning' : 'deleted' } }),
              onError: (err) => {
                setDialog(null)
                fail('save')(err)
              },
            })
          }
        />
      )}
      {(dialog === 'regenerate' || dialog === 'reprocess') && (
        <Modal title={t(`detail.${dialog}.confirmTitle`)} onClose={() => setDialog(null)}>
          <p className="modal-copy">{t(`detail.${dialog}.confirmBody`)}</p>
          <div className="modal-actions">
            <Button variant="ghost" onClick={() => setDialog(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={dialog === 'regenerate' ? runRegenerate : runProcess}>
              {t(`detail.${dialog}.confirm`)}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function RenameDialog({ current, onSave, onClose }: { current: string; onSave: (title: string) => void; onClose: () => void }) {
  const { t } = useTranslation()
  const [value, setValue] = useState(current)
  const inputId = useId()
  const trimmed = value.trim()
  return (
    <Modal title={t('detail.rename.title')} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (trimmed) onSave(trimmed)
        }}
      >
        <div className="modal-field">
          <label htmlFor={inputId}>{t('meetings.actions.renameLabel')}</label>
          <input id={inputId} value={value} onChange={(e) => setValue(e.target.value)} maxLength={200} required />
        </div>
        <div className="modal-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" aria-disabled={!trimmed}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
