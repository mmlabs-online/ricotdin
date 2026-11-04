import { describe, expect, it } from 'vitest'
import {
  durationParts,
  filterMeetings,
  needsPolling,
  sortMeetings,
  statusKind,
  withPin,
  withTitle,
  type MeetingRow,
} from './list'

const m = (id: string, over: Partial<MeetingRow> = {}): MeetingRow => ({
  id,
  user_id: 'u1',
  title: `Meeting ${id}`,
  status: 'done',
  source: 'recorded',
  duration_seconds: 60,
  pinned_at: null,
  folder_id: null,
  created_at: '2026-11-01T10:00:00Z',
  error_message: null,
  ...over,
})

describe('sortMeetings (v1 MMG-01: pinned first, newest pin on top, then newest)', () => {
  it('orders pinned by pinned_at desc, then created_at desc', () => {
    const list = [
      m('a', { created_at: '2026-11-01T00:00:00Z' }),
      m('b', { created_at: '2026-11-03T00:00:00Z' }),
      m('c', { pinned_at: '2026-11-02T00:00:00Z' }),
      m('d', { pinned_at: '2026-11-04T00:00:00Z' }),
    ]
    expect(sortMeetings(list).map((x) => x.id)).toEqual(['d', 'c', 'b', 'a'])
  })
})

describe('filterMeetings', () => {
  const list = [m('1', { title: 'Đồng bộ sản phẩm', folder_id: 'f1' }), m('2', { title: 'Weekly SYNC' }), m('3', { title: 'Planning', folder_id: 'f2' })]
  it('searches titles without case or Vietnamese accents', () => {
    expect(filterMeetings(list, { search: 'sync', folder: 'all' }).map((x) => x.id)).toEqual(['2'])
    expect(filterMeetings(list, { search: 'dong bo', folder: 'all' }).map((x) => x.id)).toEqual(['1'])
    expect(filterMeetings(list, { search: '  ', folder: 'all' })).toHaveLength(3)
  })
  it('filters by folder, or by no folder', () => {
    expect(filterMeetings(list, { search: '', folder: 'f2' }).map((x) => x.id)).toEqual(['3'])
    expect(filterMeetings(list, { search: '', folder: 'none' }).map((x) => x.id)).toEqual(['2'])
  })
})

describe('optimistic updates', () => {
  it('pin moves the meeting to the top, unpin back into date order; the input is untouched', () => {
    const list = sortMeetings([m('a', { created_at: '2026-11-02T00:00:00Z' }), m('b', { created_at: '2026-11-01T00:00:00Z' })])
    const pinned = withPin(list, 'b', '2026-11-05T00:00:00Z')
    expect(pinned.map((x) => x.id)).toEqual(['b', 'a'])
    expect(list.map((x) => x.id)).toEqual(['a', 'b'])
    expect(withPin(pinned, 'b', null).map((x) => x.id)).toEqual(['a', 'b'])
  })
  it('rename changes one title', () => {
    expect(withTitle([m('a'), m('b')], 'b', 'New').map((x) => x.title)).toEqual(['Meeting a', 'New'])
  })
})

describe('status', () => {
  it('maps to the design badges', () => {
    expect(statusKind('done')).toBe('success')
    expect(statusKind('processing')).toBe('processing')
    expect(statusKind('pending')).toBe('processing')
    expect(statusKind('failed')).toBe('danger')
    expect(statusKind('weird')).toBe('processing')
  })
  it('polls only while something is still being processed', () => {
    expect(needsPolling([m('a'), m('b', { status: 'failed' })])).toBe(false)
    expect(needsPolling([m('a'), m('b', { status: 'processing' })])).toBe(true)
    expect(needsPolling([m('a', { status: 'pending' })])).toBe(true)
  })
  it('duration parts', () => {
    expect(durationParts(42 * 60 + 10)).toEqual({ hours: 0, minutes: 42 })
    expect(durationParts(72 * 60)).toEqual({ hours: 1, minutes: 12 })
    expect(durationParts(20)).toEqual({ hours: 0, minutes: 1 })
    expect(durationParts(null)).toBeNull()
    expect(durationParts(0)).toBeNull()
  })
})
