// PRF-07: default folder for new meetings — which folders can be picked, the starting choice on
// the Record page, and what the upload sends.

import { describe, expect, it } from 'vitest'
import type { Folder } from '../../api/meetings'
import { USE_DEFAULT, assignableFolders, defaultFolderLost, folderIdForUpload, initialFolderChoice } from './defaultFolder'

function folder(id: string, myRole: Folder['myRole']): Folder {
  return { id, user_id: 'u', name: id, myRole, ownerUsername: null, memberCount: 0 } as Folder
}

const own = folder('own', 'owner')
const edit = folder('edit', 'editor')
const view = folder('view', 'viewer')

describe('assignableFolders', () => {
  it('keeps folders the user owns or edits, in order', () => {
    expect(assignableFolders([view, edit, own]).map((f) => f.id)).toEqual(['edit', 'own'])
  })
})

describe('initialFolderChoice', () => {
  it('starts on the default folder when it can still be used', () => {
    expect(initialFolderChoice('edit', [own, edit])).toBe('edit')
  })
  it('starts on "no folder" without a default, or when it is gone / view-only', () => {
    expect(initialFolderChoice(null, [own])).toBe('')
    expect(initialFolderChoice('gone', [own])).toBe('')
    expect(initialFolderChoice('view', [own, view])).toBe('')
  })
  it('is undefined while the preference or the folders are not loaded', () => {
    expect(initialFolderChoice(undefined, [own])).toBeUndefined()
    expect(initialFolderChoice('own', undefined)).toBeUndefined()
  })
})

describe('folderIdForUpload', () => {
  it('sends nothing when no choice was made (the API applies the default)', () => {
    expect(folderIdForUpload(undefined)).toBeUndefined()
  })
  it('sends nothing for "your default folder" (preferences could not be loaded)', () => {
    expect(folderIdForUpload(USE_DEFAULT)).toBeUndefined()
  })
  it('sends null for "no folder" and the id otherwise', () => {
    expect(folderIdForUpload('')).toBeNull()
    expect(folderIdForUpload('own')).toBe('own')
  })
})

describe('defaultFolderLost', () => {
  it('is true only for a saved default the user can no longer add meetings to', () => {
    expect(defaultFolderLost('gone', [own])).toBe(true)
    expect(defaultFolderLost('view', [view])).toBe(true)
    expect(defaultFolderLost('own', [own])).toBe(false)
    expect(defaultFolderLost(null, [own])).toBe(false)
    expect(defaultFolderLost('own', undefined)).toBe(false)
    expect(defaultFolderLost(undefined, [own])).toBe(false)
  })
})
