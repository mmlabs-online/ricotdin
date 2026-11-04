import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/errors'
import {
  actionErrorKey,
  audioState,
  calendarParts,
  canRegenerate,
  canReprocess,
  contentLang,
  isQueued,
  mediaSrc,
  restoreRow,
  failureKind,
  filterSegments,
  groupTranscript,
  isPastDue,
  localDateIso,
  modelLabel,
  segmentStart,
  visibleSuggestions,
  visibleTodos,
  withTodoStatus,
  type Todo,
} from './detail'

const seg = (id: string, speaker: string | null, start_ms: number, text = `text ${id}`) => ({
  id,
  speaker,
  start_ms,
  end_ms: start_ms + 1000,
  text,
})

const todo = (id: string, over: Partial<Todo> = {}): Todo => ({
  id,
  meeting_id: 'm1',
  content: `todo ${id}`,
  assignee: null,
  due_date: null,
  status: 'open',
  source_segment_id: null,
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
  ...over,
})

describe('audioState', () => {
  it('available / purged / none (v1 retention policy)', () => {
    expect(audioState({ audio_path: 'u/m', audio_purged_at: null })).toBe('available')
    expect(audioState({ audio_path: null, audio_purged_at: '2026-01-01T00:00:00Z' })).toBe('purged')
    expect(audioState({ audio_path: null, audio_purged_at: null })).toBe('none')
  })
})

describe('failureKind', () => {
  it('spots the quota block', () => {
    expect(failureKind('QUOTA_BLOCKED: need 20 min, have 3 min')).toBe('quota')
    expect(failureKind('Processing failed.')).toBe('failed')
    expect(failureKind(null)).toBe('failed')
  })
})

describe('groupTranscript', () => {
  it('groups consecutive turns of the same speaker', () => {
    const groups = groupTranscript([seg('1', 'S1', 0), seg('2', 'S1', 1000), seg('3', 'S2', 2000), seg('4', 'S1', 3000)])
    expect(groups.map((g) => [g.speaker, g.segments.map((s) => s.id)])).toEqual([
      ['S1', ['1', '2']],
      ['S2', ['3']],
      ['S1', ['4']],
    ])
  })

  it('a missing speaker is null and still groups', () => {
    expect(groupTranscript([seg('1', null, 0), seg('2', '', 10)]).map((g) => g.speaker)).toEqual([null])
  })

  it('numbers speakers in order of first appearance (stable colours)', () => {
    const groups = groupTranscript([seg('1', 'B', 0), seg('2', 'A', 1), seg('3', 'B', 2)])
    expect(groups.map((g) => g.speakerIndex)).toEqual([0, 1, 0])
  })
})

describe('filterSegments', () => {
  const list = [seg('1', 'Lan', 0, 'Đồng bộ sản phẩm'), seg('2', 'Minh', 1, 'Launch plan')]
  it('matches text or speaker, without accents or case', () => {
    expect(filterSegments(list, 'dong bo').map((s) => s.id)).toEqual(['1'])
    expect(filterSegments(list, 'MINH').map((s) => s.id)).toEqual(['2'])
    expect(filterSegments(list, '  ')).toHaveLength(2)
  })
})

describe('segmentStart', () => {
  it('finds the source segment of a to-do', () => {
    const list = [seg('a', 'S', 5000), seg('b', 'S', 9000)]
    expect(segmentStart(list, 'b')).toBe(9000)
    expect(segmentStart(list, 'zz')).toBeNull()
    expect(segmentStart(list, null)).toBeNull()
  })
})

describe('to-dos', () => {
  it('isPastDue: open with a due date before today', () => {
    expect(isPastDue(todo('1', { due_date: '2026-11-03' }), '2026-11-04')).toBe(true)
    expect(isPastDue(todo('1', { due_date: '2026-11-04' }), '2026-11-04')).toBe(false)
    expect(isPastDue(todo('1', { due_date: '2026-11-03', status: 'done' }), '2026-11-04')).toBe(false)
    expect(isPastDue(todo('1'), '2026-11-04')).toBe(false)
  })

  it('localDateIso uses the local calendar day', () => {
    expect(localDateIso(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })

  it('visibleTodos hides dismissed ones', () => {
    expect(visibleTodos([todo('1'), todo('2', { status: 'dismissed' }), todo('3', { status: 'done' })]).map((t) => t.id)).toEqual(['1', '3'])
  })

  it('withTodoStatus changes one row only', () => {
    const list = [todo('1'), todo('2')]
    const next = withTodoStatus(list, '2', 'done')
    expect(next.map((t) => t.status)).toEqual(['open', 'done'])
    expect(list[1]?.status).toBe('open')
  })
})

describe('calendar', () => {
  it('visibleSuggestions hides dismissed ones', () => {
    const list = [
      { id: '1', dismissed: false },
      { id: '2', dismissed: true },
    ]
    expect(visibleSuggestions(list).map((s) => s.id)).toEqual(['1'])
  })

  it('calendarParts formats a time in the given zone and locale', () => {
    expect(calendarParts('2026-06-07T03:00:00Z', 'en', 'Asia/Ho_Chi_Minh')).toMatchObject({ day: '07', month: 'JUN' })
    expect(calendarParts('2026-06-07T03:00:00Z', 'en', 'Asia/Ho_Chi_Minh')?.full).toContain('10:00')
    expect(calendarParts(null, 'en')).toBeNull()
    expect(calendarParts('not a date', 'en')).toBeNull()
  })
})

describe('modelLabel', () => {
  it('names the pair, or nothing', () => {
    expect(modelLabel('gemini', 'gemini-2.5-flash')).toBe('Gemini · gemini-2.5-flash')
    expect(modelLabel('acme', 'x1')).toBe('acme · x1')
    expect(modelLabel(null, 'x')).toBeNull()
    expect(modelLabel('gemini', null)).toBeNull()
  })
})

describe('owner actions', () => {
  const base = { status: 'done', audio_path: 'u/m', summary: 's' }
  it('regenerate: owner, done meeting', () => {
    expect(canRegenerate(base, 'owner')).toBe(true)
    expect(canRegenerate(base, 'editor')).toBe(false)
    expect(canRegenerate({ ...base, status: 'processing' }, 'owner')).toBe(false)
  })

  it('reprocess: owner, failed, with audio (the worker never claims a done meeting)', () => {
    expect(canReprocess({ ...base, status: 'failed' }, 'owner')).toBe(true)
    expect(canReprocess(base, 'owner')).toBe(false)
    expect(canReprocess({ ...base, audio_path: null }, 'owner')).toBe(false)
    expect(canReprocess({ ...base, status: 'pending' }, 'owner')).toBe(false)
    expect(canReprocess({ ...base, status: 'failed' }, 'viewer')).toBe(false)
  })
})

describe('actionErrorKey', () => {
  const e = (status: number, code = 'x') => new ApiError(status, code, 'server text')
  it('maps each action to its own message key', () => {
    expect(actionErrorKey('regenerate', e(402, 'quota_blocked'))).toBe('detail.errors.quota')
    expect(actionErrorKey('regenerate', e(409))).toBe('detail.errors.busy')
    expect(actionErrorKey('regenerate', e(422))).toBe('detail.errors.noTranscript')
    expect(actionErrorKey('regenerate', e(503))).toBe('detail.errors.aiUnavailable')
    expect(actionErrorKey('process', e(409))).toBe('detail.errors.cannotProcess')
    expect(actionErrorKey('ics', e(422))).toBe('detail.errors.icsNoTime')
    expect(actionErrorKey('ics', e(500))).toBe('detail.errors.icsFailed')
    expect(actionErrorKey('save', e(500))).toBe('detail.errors.saveFailed')
    expect(actionErrorKey('delete', e(500))).toBe('detail.errors.generic')
  })

  it('shared answers', () => {
    expect(actionErrorKey('process', e(429))).toBe('detail.errors.rateLimited')
    expect(actionErrorKey('save', e(403))).toBe('detail.errors.forbidden')
    expect(actionErrorKey('regenerate', e(0, 'network'))).toBe('detail.errors.network')
    expect(actionErrorKey('regenerate', new Error('x'))).toBe('detail.errors.generic')
  })
})

describe('isQueued', () => {
  it('a failed meeting the owner re-queued, until the worker touches it', () => {
    const m = { status: 'failed', updated_at: 'T1' }
    expect(isQueued(m, 'T1')).toBe(true)
    expect(isQueued(m, null)).toBe(false)
    expect(isQueued({ status: 'failed', updated_at: 'T2' }, 'T1')).toBe(false) // failed again later
    expect(isQueued({ status: 'processing', updated_at: 'T1' }, 'T1')).toBe(false)
  })
})

describe('restoreRow', () => {
  it('puts back one row only, keeping other edits', () => {
    const list = [todo('1', { status: 'done' }), todo('2', { status: 'done' })]
    const back = restoreRow(list, todo('1'))
    expect(back.map((t) => t.status)).toEqual(['open', 'done'])
  })
  it('a missing row changes nothing', () => {
    const list = [todo('1')]
    expect(restoreRow(list, todo('9'))).toEqual(list)
  })
})

describe('mediaSrc', () => {
  const api = 'https://api.example.com'
  it('accepts only a /media link on the API origin', () => {
    expect(mediaSrc(api, '/media?t=abc.def')).toBe('https://api.example.com/media?t=abc.def')
  })
  it('refuses anything that would leave the API or its /media path', () => {
    for (const bad of ['.evil.com/media?t=x', '@evil.com/media?t=x', ':8443/media?t=x', '//evil.com/media?t=x',
      'https://evil.com/media?t=x', '/other?t=x', '/media/../x?t=1', 'media?t=x', 42, null]) {
      expect(mediaSrc(api, bad)).toBeNull()
    }
  })
})

describe('contentLang', () => {
  it('a plain language tag, else none', () => {
    expect(contentLang('vi')).toBe('vi')
    expect(contentLang('en-US')).toBe('en-US')
    expect(contentLang(null)).toBeUndefined()
    expect(contentLang('auto')).toBeUndefined()
    expect(contentLang('"><x')).toBeUndefined()
  })
})
