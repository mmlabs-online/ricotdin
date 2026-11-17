import { describe, expect, it } from 'vitest'
import { applySpeakerNames, namesPatch, speakerLabels, speakerNameProblem } from './speakers'

const segs = [
  { id: '1', speaker: 'Speaker 2', start_ms: 0, text: 'a' },
  { id: '2', speaker: 'Speaker 1', start_ms: 1, text: 'b' },
  { id: '3', speaker: null, start_ms: 2, text: 'c' },
  { id: '4', speaker: 'Speaker 2', start_ms: 3, text: 'd' },
  { id: '5', speaker: '  ', start_ms: 4, text: 'e' },
]

describe('speakerLabels', () => {
  it('each label once, in order of first appearance', () => {
    expect(speakerLabels(segs)).toEqual(['Speaker 2', 'Speaker 1'])
  })
})

describe('applySpeakerNames', () => {
  it('replaces named labels and keeps the rest', () => {
    const out = applySpeakerNames(segs, { 'Speaker 1': 'Lan' })
    expect(out.map((s) => s.speaker)).toEqual(['Speaker 2', 'Lan', null, 'Speaker 2', '  '])
    expect(segs[1]!.speaker).toBe('Speaker 1') // not mutated
  })
  it('no names: the same array', () => {
    expect(applySpeakerNames(segs, undefined)).toBe(segs)
    expect(applySpeakerNames(segs, {})).toBe(segs)
  })
  it('ignores values that are not text', () => {
    expect(applySpeakerNames(segs, { 'Speaker 1': 5 } as never).map((s) => s.speaker)[1]).toBe('Speaker 1')
  })
})

describe('namesPatch', () => {
  it('only what changed; a cleared field sends null', () => {
    expect(namesPatch({ 'Speaker 1': 'Lan', 'Speaker 2': 'Minh' }, { 'Speaker 1': ' Lan ', 'Speaker 2': '', 'Speaker 3': 'An' })).toEqual({
      'Speaker 2': null,
      'Speaker 3': 'An',
    })
  })
  it('nothing changed: empty', () => {
    expect(namesPatch({}, { 'Speaker 1': '  ' })).toEqual({})
  })
})

describe('speakerNameProblem', () => {
  it('checks like the API', () => {
    expect(speakerNameProblem('Lan')).toBeNull()
    expect(speakerNameProblem('')).toBeNull() // clears
    expect(speakerNameProblem('x'.repeat(61))).toBe('detail.speakers.tooLong')
    expect(speakerNameProblem('La‮n')).toBe('detail.speakers.invisible')
  })
})
