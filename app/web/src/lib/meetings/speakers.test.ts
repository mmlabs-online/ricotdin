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
  it('only touched fields that changed; a cleared field sends null', () => {
    const before = { 'Speaker 1': 'Lan', 'Speaker 2': 'Minh' }
    const draft = { 'Speaker 1': ' Lan ', 'Speaker 2': '', 'Speaker 3': 'An' }
    expect(namesPatch(before, draft, new Set(['Speaker 1', 'Speaker 2', 'Speaker 3']))).toEqual({ 'Speaker 2': null, 'Speaker 3': 'An' })
  })
  it('an untouched stale field never reverts someone else’s name', () => {
    expect(namesPatch({ 'Speaker 1': 'Lan' }, { 'Speaker 1': '', 'Speaker 2': 'An' }, new Set(['Speaker 2']))).toEqual({ 'Speaker 2': 'An' })
  })
  it('nothing changed: empty', () => {
    expect(namesPatch({}, { 'Speaker 1': '  ' }, new Set(['Speaker 1']))).toEqual({})
  })
})

describe('speakerNameProblem', () => {
  const labels = ['Speaker 1', 'Speaker 2']
  it('checks like the API', () => {
    expect(speakerNameProblem('Lan', 'Speaker 1', labels)).toBeNull()
    expect(speakerNameProblem('', 'Speaker 1', labels)).toBeNull() // clears
    expect(speakerNameProblem('Speaker 1', 'Speaker 1', labels)).toBeNull()
    expect(speakerNameProblem('x'.repeat(61), 'Speaker 1', labels)).toBe('detail.speakers.tooLong')
    expect(speakerNameProblem('🙂'.repeat(60), 'Speaker 1', labels)).toBeNull() // code points, like Python
    expect(speakerNameProblem(`a${' '.repeat(10)}b${'c'.repeat(55)}`, 'Speaker 1', labels)).toBeNull() // spaces collapse
    expect(speakerNameProblem('La\u202en', 'Speaker 1', labels)).toBe('detail.speakers.invisible')
    expect(speakerNameProblem('Lan] x', 'Speaker 1', labels)).toBe('detail.speakers.brackets')
    expect(speakerNameProblem('<Lan>', 'Speaker 1', labels)).toBe('detail.speakers.brackets')
    expect(speakerNameProblem('speaker 2', 'Speaker 1', labels)).toBe('detail.speakers.otherLabel')
  })
})
