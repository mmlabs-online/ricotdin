import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/errors'
import { historyErrorKey, normalizeVersion, normalizeVersions, versionLinks } from './history'

const row = {
  id: '11111111-1111-4111-8111-111111111111',
  field: 'notes',
  source: 'user',
  editedBy: '22222222-2222-4222-8222-222222222222',
  editedByUsername: 'ming',
  createdAt: '2026-11-09T10:00:00+00:00',
  length: 42,
}

describe('normalizeVersions (PRO-06 6b)', () => {
  it('keeps well-formed rows in the order the API sent them (newest first)', () => {
    const second = { ...row, id: '33333333-3333-4333-8333-333333333333', source: 'ai', editedBy: null, editedByUsername: null }
    expect(normalizeVersions({ versions: [row, second] })).toEqual([
      { id: row.id, source: 'user', editedByUsername: 'ming', createdAt: row.createdAt, length: 42 },
      { id: second.id, source: 'ai', editedByUsername: null, createdAt: row.createdAt, length: 42 },
    ])
  })

  it('drops rows it cannot show and answers [] for a bad body', () => {
    expect(normalizeVersions({ versions: [{ ...row, source: 'robot' }, { ...row, id: 5 }, { ...row, createdAt: 'soon' }, null] })).toEqual([])
    expect(normalizeVersions(null)).toEqual([])
    expect(normalizeVersions({ versions: 'x' })).toEqual([])
  })

  it('never shows an author on an AI version, and a missing username as null', () => {
    const [ai] = normalizeVersions({ versions: [{ ...row, source: 'ai' }] })
    expect(ai?.editedByUsername).toBeNull()
    const [anon] = normalizeVersions({ versions: [{ ...row, editedByUsername: undefined }] })
    expect(anon?.editedByUsername).toBeNull()
  })
})

describe('normalizeVersion', () => {
  it('needs the text and its hash', () => {
    const body = { id: row.id, field: 'notes', source: 'restore', createdAt: row.createdAt, content: 'x', contentHash: 'ab' }
    expect(normalizeVersion(body)).toEqual({ id: row.id, source: 'restore', createdAt: row.createdAt, content: 'x', contentHash: 'ab' })
    expect(normalizeVersion({ ...body, content: 5 })).toBeNull()
    expect(normalizeVersion({ ...body, contentHash: undefined })).toBeNull()
  })
})

describe('versionLinks', () => {
  it('lets only a version a person wrote have links (AI text never does)', () => {
    expect(versionLinks('user')).toBe(true)
    expect(versionLinks('restore')).toBe(true)
    expect(versionLinks('ai')).toBe(false)
  })
})

describe('historyErrorKey', () => {
  it('maps restore and load errors to keys, never server text', () => {
    expect(historyErrorKey(new ApiError(409, 'content_changed', 'x'))).toBe('detail.history.errors.changed')
    expect(historyErrorKey(new ApiError(404, 'not_found', 'x'))).toBe('detail.history.errors.gone')
    expect(historyErrorKey(new ApiError(403, 'forbidden', 'x'))).toBe('detail.errors.forbidden')
    expect(historyErrorKey(new ApiError(409, 'conflict', 'x'))).toBe('detail.edit.errors.notDone')
    expect(historyErrorKey(new ApiError(429, 'rate_limited', 'x'))).toBe('detail.errors.rateLimited')
    expect(historyErrorKey(new ApiError(0, 'network', 'x'))).toBe('detail.errors.network')
    expect(historyErrorKey(new Error('boom'))).toBe('detail.history.errors.failed')
  })
})
