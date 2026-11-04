import { describe, expect, it } from 'vitest'
import { canDelete, canManageShares, canMove, canPin, canRename, getMeetingRole } from './roles'

const me = 'u-me'
const folders = [
  { id: 'f-own', user_id: me, myRole: 'owner' as const },
  { id: 'f-ed', user_id: 'u-x', myRole: 'editor' as const },
  { id: 'f-view', user_id: 'u-y', myRole: 'viewer' as const },
]

// v2 API rules (CLAUDE.md §0.6): pin/move/delete = meeting owner; rename = owner or editor.
describe('getMeetingRole', () => {
  it('owner, then the role of the share that shows the meeting', () => {
    expect(getMeetingRole({ user_id: me, folder_id: null }, me, folders)).toBe('owner')
    expect(getMeetingRole({ user_id: 'u-x', folder_id: 'f-ed' }, me, folders)).toBe('editor')
    expect(getMeetingRole({ user_id: 'u-y', folder_id: 'f-view' }, me, folders)).toBe('viewer')
    expect(getMeetingRole({ user_id: 'u-z', folder_id: null }, me, folders)).toBe('viewer') // admin read
    expect(getMeetingRole({ user_id: 'u-z', folder_id: 'f-unknown' }, me, folders)).toBe('viewer')
    // someone else's meeting in MY folder: the API gives the folder owner owner-level access,
    // but pin / move / delete stay with the meeting owner → treat as editor in the UI
    expect(getMeetingRole({ user_id: 'u-x', folder_id: 'f-own' }, me, folders)).toBe('editor')
  })
})

describe('permissions', () => {
  it('follow the v2 API', () => {
    expect(canRename('owner')).toBe(true)
    expect(canRename('editor')).toBe(true)
    expect(canRename('viewer')).toBe(false)
    for (const f of [canPin, canMove, canDelete]) {
      expect(f('owner')).toBe(true)
      expect(f('editor')).toBe(false)
      expect(f('viewer')).toBe(false)
    }
    expect(canManageShares({ user_id: me }, me)).toBe(true)
    expect(canManageShares({ user_id: 'u-x' }, me)).toBe(false)
  })
})
