import { describe, expect, it } from 'vitest'
import { formatClock, icsFilename, meetingSeekPath, nearestSegment, parseSeekParam } from './seek'

describe('meeting seek links (chat citation → meeting at a time)', () => {
  it('builds and reads ?t=<seconds>', () => {
    expect(meetingSeekPath('m-1', 65_400)).toBe('/meetings/m-1?t=65')
    expect(meetingSeekPath('a b', 0)).toBe('/meetings/a%20b?t=0')
    expect(parseSeekParam('?t=65')).toBe(65_000)
    expect(parseSeekParam('?x=1&t=7')).toBe(7000)
  })
  it('ignores bad values', () => {
    for (const q of ['', '?t=', '?t=-1', '?t=abc', '?t=1e9', '?t=99999999']) expect(parseSeekParam(q), q).toBeNull()
  })
})

describe('nearestSegment', () => {
  const segs = [{ start_ms: 0 }, { start_ms: 5000 }, { start_ms: 65_000 }]
  it('picks the segment closest to the time', () => {
    expect(nearestSegment(segs, 6000)).toBe(segs[1])
    expect(nearestSegment(segs, 50_000)).toBe(segs[2])
    expect(nearestSegment([], 1)).toBeNull()
  })
})

describe('formatClock', () => {
  it('mm:ss, and h:mm:ss past an hour', () => {
    expect(formatClock(65)).toBe('01:05')
    expect(formatClock(3725)).toBe('1:02:05')
    expect(formatClock(Number.NaN)).toBe('00:00')
    expect(formatClock(Infinity)).toBe('00:00')
  })
})

describe('icsFilename', () => {
  it('slugs the title like v1', () => {
    expect(icsFilename('Launch readiness review!')).toBe('launch-readiness-review.ics')
    expect(icsFilename('Đánh giá')).toBe('nh-gi.ics')
    expect(icsFilename('')).toBe('event.ics')
  })
})
