import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/errors'
import { folderErrorKey } from './FoldersDialog'

describe('folderErrorKey', () => {
  it('names the invisible-character refusal instead of the generic name error (SEC-05)', () => {
    expect(folderErrorKey(new ApiError(400, 'invalid_characters', 'x'))).toBe('errors.invisibleCharacters')
    expect(folderErrorKey(new ApiError(400, 'bad_request', 'x'))).toBe('folders.errors.name')
    expect(folderErrorKey(new ApiError(409, 'conflict', 'x'))).toBe('folders.errors.duplicate')
  })
})
