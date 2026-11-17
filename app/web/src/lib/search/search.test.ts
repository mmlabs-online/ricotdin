import { describe, expect, it } from 'vitest'
import { highlightParts, readSearchParams, resultHref, searchHref, validQuery } from './search'

describe('highlightParts', () => {
  it('splits text around the ranges', () => {
    expect(highlightParts('Chốt NGÂN SÁCH quý ba', [[5, 9], [10, 14]])).toEqual([
      { text: 'Chốt ', mark: false },
      { text: 'NGÂN', mark: true },
      { text: ' ', mark: false },
      { text: 'SÁCH', mark: true },
      { text: ' quý ba', mark: false },
    ])
  })
  it('no ranges: the whole text', () => {
    expect(highlightParts('abc', [])).toEqual([{ text: 'abc', mark: false }])
  })
  it('ignores ranges that are out of order, overlapping or outside the text', () => {
    expect(highlightParts('abcdef', [[4, 9], [4, 6], [0, 2], [1, 3], [-1, 1], [5, 5]])).toEqual([
      { text: 'ab', mark: true },
      { text: 'cd', mark: false },
      { text: 'ef', mark: true },
    ])
  })
})

describe('resultHref', () => {
  it('a transcript hit opens the meeting at that second', () => {
    expect(resultHref('m-1', { kind: 'transcript', startMs: 125_400 })).toBe('/meetings/m-1?t=125')
  })
  it('a summary or notes hit opens the meeting', () => {
    expect(resultHref('m 1', { kind: 'summary', startMs: null })).toBe('/meetings/m%201')
    expect(resultHref('m-1', { kind: 'notes', startMs: null })).toBe('/meetings/m-1')
  })
})

describe('search params', () => {
  it('reads q and folder from the URL', () => {
    expect(readSearchParams('?q=ng%C3%A2n+s%C3%A1ch&folder=f1')).toEqual({ q: 'ngân sách', folder: 'f1' })
    expect(readSearchParams('')).toEqual({ q: '', folder: '' })
  })
  it('builds the link from the Meetings page', () => {
    expect(searchHref('  ngân sách ')).toBe('/search?q=ng%C3%A2n+s%C3%A1ch')
    expect(searchHref('a b', 'f1')).toBe('/search?q=a+b&folder=f1')
    expect(searchHref('')).toBe('/search')
  })
  it('a query needs 2 to 200 characters', () => {
    expect(validQuery(' a ')).toBe(false)
    expect(validQuery('ab')).toBe(true)
    expect(validQuery('x'.repeat(201))).toBe(false)
  })
})
