// The tab panels of the meeting detail screen (Make MeetingDetail). Text written by the AI or by
// other users goes through displayText / Markdown (no links, images or bidi tricks).
import { useEffect, useRef, useState } from 'react'
import { CalendarDays, Copy, FileAudio, ListTodo, MessageSquareText, RefreshCw, Search, Sparkles, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  calendarParts,
  filterSegments,
  groupTranscript,
  isPastDue,
  localDateIso,
  segmentStart,
  visibleSuggestions,
  visibleTodos,
  type CalendarSuggestion,
  type Todo,
  type TodoStatus,
} from '../../lib/meetings/detail'
import { formatClock } from '../../lib/media/seek'
import { displayText } from '../../lib/text'
import type { TranscriptSegment } from '../../lib/transcript/export'
import { Markdown } from '../Markdown'
import { Button } from '../ui/Button'

const clock = (ms: number) => formatClock(ms / 1000)

function Loading({ state, onRetry }: { state: 'pending' | 'error'; onRetry: () => void }) {
  const { t } = useTranslation()
  if (state === 'pending') return <p className="tab-note">{t('common.loading')}</p>
  return (
    <div className="tab-note">
      <p>{t('detail.loadError')}</p>
      <Button onClick={onRetry}>{t('common.tryAgain')}</Button>
    </div>
  )
}

export function SummaryPanel({
  summary,
  model,
  regenerate,
}: {
  summary: string | null
  model: string | null
  regenerate: { visible: boolean; busy: boolean; onClick: () => void } | null
}) {
  const { t } = useTranslation()
  return (
    <article className="summary-card">
      <h2 className="section-label">
        <Sparkles size={16} aria-hidden="true" />
        {t('detail.summary.label')}
      </h2>
      {summary?.trim() ? <Markdown source={summary} /> : <p className="tab-note">{t('detail.summary.empty')}</p>}
      <div className="panel-footer">
        {model && <span className="model-label">{t('detail.summary.model', { model: displayText(model) })}</span>}
        {regenerate?.visible && (
          <Button onClick={regenerate.onClick} aria-disabled={regenerate.busy} aria-busy={regenerate.busy} data-focus="regenerate">
            <RefreshCw size={15} aria-hidden="true" />
            {regenerate.busy ? t('detail.regenerate.busy') : t('detail.regenerate.action')}
          </Button>
        )}
      </div>
    </article>
  )
}

export function NotesPanel({ notes }: { notes: string | null }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null)
  async function copy() {
    try {
      await navigator.clipboard.writeText(notes ?? '')
      setCopied('ok')
    } catch {
      setCopied('failed')
    }
  }
  return (
    <article className="summary-card notes-content">
      <h2 className="section-label">
        <FileAudio size={16} aria-hidden="true" />
        {t('detail.notes.label')}
      </h2>
      {notes?.trim() ? (
        <>
          <Markdown source={notes} />
          <div className="panel-footer">
            <Button onClick={() => void copy()}>
              <Copy size={15} aria-hidden="true" />
              {t('detail.notes.copy')}
            </Button>
            <span role="status" className="tab-note">
              {copied === 'ok' ? t('detail.notes.copied') : copied === 'failed' ? t('detail.notes.copyFailed') : ''}
            </span>
          </div>
        </>
      ) : (
        <p className="tab-note">{t('detail.notes.empty')}</p>
      )}
    </article>
  )
}

export function TodosPanel({
  todos,
  state,
  onRetry,
  segments,
  canEdit,
  onStatus,
  onSource,
}: {
  todos: Todo[]
  state: 'pending' | 'error' | 'success'
  onRetry: () => void
  segments: TranscriptSegment[]
  canEdit: boolean
  onStatus: (id: string, status: TodoStatus) => void
  onSource: (ms: number) => void
}) {
  const { t, i18n } = useTranslation()
  const [today] = useState(() => localDateIso(new Date()))
  if (state !== 'success') return <Loading state={state} onRetry={onRetry} />
  const list = visibleTodos(todos)
  const date = (iso: string) =>
    new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`))
  return (
    <section className="todo-card" aria-labelledby="todos-title">
      <h2 className="section-label" id="todos-title" tabIndex={-1}>
        <ListTodo size={16} aria-hidden="true" />
        {t('detail.todos.label')}
      </h2>
      {list.length === 0 ? (
        <p className="tab-note">{t('detail.todos.empty')}</p>
      ) : (
        <ul className="detail-list">
          {list.map((todo) => {
            const done = todo.status === 'done'
            const late = isPastDue(todo, today)
            const source = segmentStart(segments, todo.source_segment_id)
            const content = displayText(todo.content)
            return (
              <li className={`todo-row${done ? ' done' : ''}`} key={todo.id}>
                <input
                  type="checkbox"
                  checked={done}
                  aria-label={t(done ? 'detail.todos.markOpen' : 'detail.todos.markDone', { item: content })}
                  disabled={!canEdit}
                  onChange={() => onStatus(todo.id, done ? 'open' : 'done')}
                />
                <span>
                  <strong>{content}</strong>
                  <small className={late ? 'late' : undefined}>
                    {todo.due_date ? t(late ? 'detail.todos.overdue' : 'detail.todos.due', { date: date(todo.due_date) }) : t('detail.todos.noDue')}
                    {todo.assignee ? ` · ${displayText(todo.assignee)}` : ''}
                  </small>
                </span>
                <span className="row-actions">
                  {source !== null && (
                    <button type="button" className="link-button" onClick={() => onSource(source)}>
                      {t('detail.source', { time: clock(source) })}
                    </button>
                  )}
                  {canEdit && (
                    <Button
                      variant="ghost"
                      onClick={() => onStatus(todo.id, 'dismissed')}
                      aria-label={t('detail.todos.dismiss', { item: content })}
                      data-todo-dismiss={todo.id}
                    >
                      <X size={15} aria-hidden="true" />
                    </Button>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export function CalendarPanel({
  suggestions,
  state,
  onRetry,
  segments,
  canEdit,
  onDismiss,
  onIcs,
  onSource,
}: {
  suggestions: CalendarSuggestion[]
  state: 'pending' | 'error' | 'success'
  onRetry: () => void
  segments: TranscriptSegment[]
  canEdit: boolean
  onDismiss: (id: string) => void
  onIcs: (s: CalendarSuggestion) => void
  onSource: (ms: number) => void
}) {
  const { t, i18n } = useTranslation()
  if (state !== 'success') return <Loading state={state} onRetry={onRetry} />
  const list = visibleSuggestions(suggestions)
  return (
    <section className="calendar-content" aria-labelledby="calendar-title">
      <h2 className="section-label" id="calendar-title" tabIndex={-1}>
        <CalendarDays size={16} aria-hidden="true" />
        {t('detail.calendar.label')}
      </h2>
      {list.length === 0 ? (
        <p className="tab-note">{t('detail.calendar.empty')}</p>
      ) : (
        <ul className="detail-list">
          {list.map((s) => {
            const parts = calendarParts(s.proposed_at, i18n.resolvedLanguage ?? 'en')
            const source = segmentStart(segments, s.source_segment_id)
            const title = displayText(s.title)
            return (
              <li className="calendar-event" key={s.id}>
                <div className={parts ? 'calendar-date' : 'calendar-date unknown'} aria-hidden="true">
                  {parts ? (
                    <>
                      <strong>{parts.day}</strong>
                      <span>{parts.month}</span>
                    </>
                  ) : (
                    <CalendarDays size={18} />
                  )}
                </div>
                <div>
                  <strong>{title}</strong>
                  <p>{parts ? parts.full : t('detail.calendar.noTime')}</p>
                  {s.raw_mention && <small>{t('detail.calendar.mention', { text: displayText(s.raw_mention) })}</small>}
                  {source !== null && (
                    <button type="button" className="link-button" onClick={() => onSource(source)}>
                      {t('detail.source', { time: clock(source) })}
                    </button>
                  )}
                </div>
                <div className="calendar-actions">
                  {parts ? (
                    <Button onClick={() => onIcs(s)}>{t('detail.calendar.ics')}</Button>
                  ) : (
                    <small>{t('detail.calendar.manual')}</small>
                  )}
                  {canEdit && (
                    <Button variant="ghost" onClick={() => onDismiss(s.id)} aria-label={t('detail.calendar.dismiss', { title })} data-cal-dismiss={s.id}>
                      <X size={15} aria-hidden="true" />
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <p className="calendar-note">{t('detail.calendar.noSync')}</p>
    </section>
  )
}

export function TranscriptPanel({
  segments,
  state,
  onRetry,
  canSeek,
  activeId,
  onSeek,
}: {
  segments: TranscriptSegment[]
  state: 'pending' | 'error' | 'success'
  onRetry: () => void
  canSeek: boolean
  activeId: string | null
  onSeek: (seg: TranscriptSegment) => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const activeRef = useRef<HTMLLIElement>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'center' })
  }, [activeId])
  if (state !== 'success') return <Loading state={state} onRetry={onRetry} />
  const groups = groupTranscript(filterSegments(segments, query))
  return (
    <section className="transcript-content" aria-labelledby="transcript-title">
      <div className="transcript-toolbar">
        <h2 className="section-label" id="transcript-title">
          <MessageSquareText size={16} aria-hidden="true" />
          {t('detail.transcript.label')}
        </h2>
        {segments.length > 0 && (
          <label className="search">
            <Search size={15} aria-hidden="true" />
            <span className="sr-only">{t('detail.transcript.search')}</span>
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('detail.transcript.searchPlaceholder')} />
          </label>
        )}
      </div>
      <p className="sr-only" role="status">
        {query.trim() ? t('detail.transcript.matches', { count: groups.reduce((n, g) => n + g.segments.length, 0) }) : ''}
      </p>
      {segments.length === 0 ? (
        <p className="tab-note">{t('detail.transcript.empty')}</p>
      ) : groups.length === 0 ? (
        <p className="tab-note">{t('detail.transcript.noMatch')}</p>
      ) : (
        <ol className="detail-list">
          {groups.map((g) => {
            const speaker = g.speaker ? displayText(g.speaker) : t('detail.transcript.unknownSpeaker')
            return g.segments.map((s, n) => (
              <li
                key={s.id}
                ref={s.id === activeId ? activeRef : undefined}
                className={`transcript-row${s.id === activeId ? ' active' : ''}${n > 0 ? ' continued' : ''}`}
              >
                {canSeek ? (
                  <button type="button" onClick={() => onSeek(s)} aria-label={t('detail.transcript.playFrom', { time: clock(s.start_ms), speaker })}>
                    {clock(s.start_ms)}
                  </button>
                ) : (
                  <span className="time">{clock(s.start_ms)}</span>
                )}
                <div>
                  {n === 0 ? <strong className={`speaker speaker-${g.speakerIndex % 6}`}>{speaker}</strong> : <span className="sr-only">{speaker}</span>}
                  <p>{displayText(s.text)}</p>
                </div>
              </li>
            ))
          })}
        </ol>
      )}
    </section>
  )
}
