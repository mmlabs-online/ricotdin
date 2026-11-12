// Meeting detail helpers (ARC-13b: MTD-01..03, CAL-01..03, PRP-04/07, PRV-02, AIP-03). Pure.
import { ApiError } from '../../api/errors'
import type { MeetingRole } from '../access/roles'
import { searchKey } from './list'
import { isInvisibleCharactersError } from '../text'

export type TodoStatus = 'open' | 'done' | 'dismissed'
export interface Todo {
  id: string
  meeting_id: string
  content: string
  assignee: string | null
  due_date: string | null
  status: TodoStatus
  source_segment_id: string | null
  created_at: string
  updated_at: string
}
export interface CalendarSuggestion {
  id: string
  meeting_id: string
  title: string
  proposed_at: string | null
  raw_mention: string | null
  source_segment_id: string | null
  dismissed: boolean
  created_at: string
}
interface Segment {
  id: string
  speaker: string | null
  start_ms: number
  text: string
}

/** v1 `audioState`: purged by the retention policy (PRV-02) vs never had audio. */
export function audioState(m: { audio_path: string | null; audio_purged_at: string | null }): 'available' | 'purged' | 'none' {
  if (m.audio_path) return 'available'
  return m.audio_purged_at ? 'purged' : 'none'
}

/** The worker writes `QUOTA_BLOCKED: …` when the audio balance was too low (QUO-02). */
export function failureKind(errorMessage: string | null): 'quota' | 'failed' {
  return errorMessage?.startsWith('QUOTA_BLOCKED:') ? 'quota' : 'failed'
}

export interface SpeakerGroup<T> {
  speaker: string | null
  /** Order of first appearance, for a stable colour per speaker. */
  speakerIndex: number
  segments: T[]
}

/** Consecutive turns of one speaker shown together (v1). */
export function groupTranscript<T extends Segment>(segments: readonly T[]): SpeakerGroup<T>[] {
  const order = new Map<string, number>()
  const groups: SpeakerGroup<T>[] = []
  for (const s of segments) {
    const speaker = s.speaker?.trim() ? s.speaker : null
    const name = speaker ?? ''
    if (!order.has(name)) order.set(name, order.size)
    const last = groups[groups.length - 1]
    if (last && last.speaker === speaker) last.segments.push(s)
    else groups.push({ speaker, speakerIndex: order.get(name) ?? 0, segments: [s] })
  }
  return groups
}

export function filterSegments<T extends Segment>(segments: readonly T[], query: string): T[] {
  const q = searchKey(query)
  if (!q) return [...segments]
  return segments.filter((s) => searchKey(`${s.speaker ?? ''} ${s.text}`).includes(q))
}

/** Start of a to-do's / suggestion's source segment ("jump to source", MTD-03). */
export function segmentStart(segments: readonly Segment[], id: string | null): number | null {
  if (!id) return null
  return segments.find((s) => s.id === id)?.start_ms ?? null
}

export function localDateIso(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function isPastDue(t: Pick<Todo, 'status' | 'due_date'>, today: string): boolean {
  return t.status === 'open' && !!t.due_date && t.due_date < today
}

export function visibleTodos<T extends Pick<Todo, 'status'>>(list: readonly T[]): T[] {
  return list.filter((t) => t.status !== 'dismissed')
}

export function withTodoStatus<T extends Pick<Todo, 'id' | 'status'>>(list: readonly T[], id: string, status: TodoStatus): T[] {
  return list.map((t) => (t.id === id ? { ...t, status } : t))
}

export function visibleSuggestions<T extends { dismissed: boolean }>(list: readonly T[]): T[] {
  return list.filter((s) => !s.dismissed)
}

/** Date badge + full text for a suggestion; null without a real time (CAL-02: never invent one). */
export function calendarParts(
  iso: string | null,
  locale: string,
  timeZone?: string,
): { day: string; month: string; full: string } | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const tz = timeZone ? { timeZone } : {}
  return {
    day: new Intl.DateTimeFormat(locale, { day: '2-digit', ...tz }).format(date),
    month: new Intl.DateTimeFormat(locale, { month: 'short', ...tz }).format(date).replace('.', '').toUpperCase(),
    full: new Intl.DateTimeFormat(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      ...tz,
    }).format(date),
  }
}

const PROVIDER_NAMES: Record<string, string> = { gemini: 'Gemini', openai: 'OpenAI', grok: 'Grok' }

/** The model a meeting was analysed with (AIP-03). */
export function modelLabel(provider: string | null, model: string | null): string | null {
  if (!provider || !model) return null
  return `${PROVIDER_NAMES[provider] ?? provider} · ${model}`
}

type ActionMeeting = { status: string; audio_path: string | null }

/** Owner only, on a finished meeting (the API answers 409 while it is processing). */
export function canRegenerate(m: ActionMeeting, role: MeetingRole): boolean {
  return role === 'owner' && m.status === 'done'
}

/** Owner only, with audio, after a failure. Not for a `done` meeting: `/process` queues a job, but
 * the worker only claims `pending` / `failed` meetings, so it would end without doing anything. */
export function canReprocess(m: ActionMeeting, role: MeetingRole): boolean {
  return role === 'owner' && !!m.audio_path && m.status === 'failed'
}

/** The owner pressed "Process again" on this failed meeting and the worker has not claimed it yet
 * (claiming moves it to `processing` and bumps `updated_at`). `queuedAt` = its `updated_at` then. */
export function isQueued(m: { status: string; updated_at: string }, queuedAt: string | null): boolean {
  return queuedAt !== null && m.status === 'failed' && m.updated_at === queuedAt
}

/** The playback link from `/audio-url` as an absolute URL, only if it is the API's own `/media`
 * (a malformed answer such as `.evil.com/…` or `@evil.com/…` must not move the request elsewhere). */
export function mediaSrc(apiUrl: string, path: unknown): string | null {
  if (typeof path !== 'string' || !path.startsWith('/media?')) return null
  try {
    const base = new URL(apiUrl)
    const url = new URL(path, base)
    return url.origin === base.origin && url.pathname === '/media' ? url.href : null
  } catch {
    return null
  }
}

/** `lang` for the meeting's own text (3.1.2): the detected language when it is a plain tag. */
export function contentLang(language: string | null): string | undefined {
  return language && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language) && language !== 'auto' ? language : undefined
}

/** Undo one optimistic row change, leaving other rows' in-flight edits alone. */
export function restoreRow<T extends { id: string }>(list: readonly T[], prev: T): T[] {
  return list.map((x) => (x.id === prev.id ? prev : x))
}

export type DetailAction = 'regenerate' | 'process' | 'save' | 'ics' | 'delete'

export function actionErrorKey(action: DetailAction, err: unknown): string {
  if (!(err instanceof ApiError)) return 'detail.errors.generic'
  if (err.status === 0) return 'detail.errors.network'
  if (err.status === 429) return 'detail.errors.rateLimited'
  if (err.status === 403) return 'detail.errors.forbidden'
  switch (action) {
    case 'regenerate':
      if (err.status === 402) return 'detail.errors.quota'
      if (err.status === 409) return 'detail.errors.busy'
      if (err.status === 422) return 'detail.errors.noTranscript'
      if (err.status === 502 || err.status === 503) return 'detail.errors.aiUnavailable'
      return 'detail.errors.generic'
    case 'process':
      return err.status === 409 ? 'detail.errors.cannotProcess' : 'detail.errors.generic'
    case 'ics':
      return err.status === 422 ? 'detail.errors.icsNoTime' : 'detail.errors.icsFailed'
    case 'save':
      return isInvisibleCharactersError(err) ? 'errors.invisibleCharacters' : 'detail.errors.saveFailed'
    case 'delete':
      return 'detail.errors.generic'
  }
}
