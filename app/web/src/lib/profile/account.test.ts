import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/errors'
import { deleteConfirmed, deleteMayHaveHappened, deleteProblem, filenameFromDisposition } from './account'

describe('deleteConfirmed', () => {
  it('needs the exact username (spaces around are fine)', () => {
    expect(deleteConfirmed(' lan ', 'lan')).toBe(true)
    expect(deleteConfirmed('Lan', 'lan')).toBe(false)
    expect(deleteConfirmed('', 'lan')).toBe(false)
    expect(deleteConfirmed('lan', null)).toBe(false)
  })
})

describe('filenameFromDisposition', () => {
  it('takes the quoted file name, else the fallback', () => {
    expect(filenameFromDisposition('attachment; filename="ricotdin-export-lan-2026-11-17.zip"', 'x.zip')).toBe('ricotdin-export-lan-2026-11-17.zip')
    expect(filenameFromDisposition(null, 'x.zip')).toBe('x.zip')
    expect(filenameFromDisposition('attachment', 'x.zip')).toBe('x.zip')
  })
  it('never a path', () => {
    expect(filenameFromDisposition('attachment; filename="../../evil.zip"', 'x.zip')).toBe('evil.zip')
  })
})

describe('deleteProblem', () => {
  it('empty, wrong, or none', () => {
    expect(deleteProblem('  ', 'lan')).toBe('profile.data.confirmEmpty')
    expect(deleteProblem('Lan', 'lan')).toBe('profile.data.confirmMismatch')
    expect(deleteProblem('lan', 'lan')).toBeNull()
  })
})

describe('deleteMayHaveHappened', () => {
  it('a lost answer or an already disabled account', () => {
    expect(deleteMayHaveHappened(new ApiError(0, 'network', 'x'))).toBe(true)
    expect(deleteMayHaveHappened(new ApiError(504, 'internal', 'x'))).toBe(true)
    expect(deleteMayHaveHappened(new ApiError(403, 'account_disabled', 'x'))).toBe(true)
    expect(deleteMayHaveHappened(new TypeError('fetch failed'))).toBe(true)
  })
  it('a refusal is not', () => {
    expect(deleteMayHaveHappened(new ApiError(400, 'bad_request', 'x'))).toBe(false)
    expect(deleteMayHaveHappened(new ApiError(429, 'rate_limited', 'x'))).toBe(false)
  })
})
