import { describe, expect, it } from 'vitest'
import { deleteConfirmed, deleteProblem, filenameFromDisposition } from './account'

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
