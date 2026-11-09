import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/errors'
import { canEditContent, contentHash, editErrorKey, isDirty } from './edit'

describe('contentHash (PRO-06, same as the API content_hash)', () => {
  it('is the sha-256 hex of the UTF-8 text; null is empty', async () => {
    expect(await contentHash(null)).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(await contentHash('')).toBe(await contentHash(null))
    expect(await contentHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
  it('hashes UTF-8, not UTF-16', async () => {
    expect(await contentHash('Họp')).toBe('24134bd3eb6b49bdf3600f9cf3f3bfb166e2e5e2668b1d037c9075042887de40')
  })
})

describe('canEditContent', () => {
  it('owner and editor, finished meetings only', () => {
    expect(canEditContent('owner', 'done')).toBe(true)
    expect(canEditContent('editor', 'done')).toBe(true)
    expect(canEditContent('viewer', 'done')).toBe(false)
    expect(canEditContent('owner', 'processing')).toBe(false)
    expect(canEditContent('owner', 'failed')).toBe(false)
  })
})

describe('isDirty', () => {
  it('compares with the text the edit started from; null = empty', () => {
    expect(isDirty(null, '')).toBe(false)
    expect(isDirty('a', 'a')).toBe(false)
    expect(isDirty('a', 'b')).toBe(true)
  })
})

describe('editErrorKey', () => {
  const e = (status: number, code = 'x') => new ApiError(status, code, 'server text')
  it('maps codes and statuses to messages, never the server text', () => {
    expect(editErrorKey(e(409, 'content_changed'))).toBe('detail.edit.errors.changed')
    expect(editErrorKey(e(409, 'conflict'))).toBe('detail.edit.errors.notDone')
    expect(editErrorKey(e(422, 'invalid_characters'))).toBe('detail.edit.errors.characters')
    expect(editErrorKey(e(422))).toBe('detail.edit.errors.invalid')
    expect(editErrorKey(e(403))).toBe('detail.errors.forbidden')
    expect(editErrorKey(e(429))).toBe('detail.errors.rateLimited')
    expect(editErrorKey(e(0, 'network'))).toBe('detail.errors.network')
    expect(editErrorKey(new Error('x'))).toBe('detail.edit.errors.failed')
  })
})
