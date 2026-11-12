// Unit tests for the folder delete confirm-panel notice (BUG-014) and counts (BUG-015).
//
// Deleting a folder cascades away its folder-scoped chat sessions for every user
// (by design, see BUG-013); both confirm panels must say so.

import { describe, expect, it } from 'vitest'
import assert from '../../test/assert'
import { folderDeleteChatNotice, folderDeleteCounts, meetingsAfterFolderDelete } from './deleteNotice'

describe('folderDeleteChatNotice (i18n key + member count)', () => {
  it('no members: only the owner\'s folder chats', () => {
    expect(folderDeleteChatNotice(0)).toEqual({ key: 'folders.delete.chatNotice', count: 0 })
  })
  it('members: everyone\'s chats, with a clean whole count', () => {
    expect(folderDeleteChatNotice(1)).toEqual({ key: 'folders.delete.chatNoticeShared', count: 1 })
    expect(folderDeleteChatNotice(2.7)).toEqual({ key: 'folders.delete.chatNoticeShared', count: 2 })
    expect(folderDeleteChatNotice(-1)).toEqual({ key: 'folders.delete.chatNotice', count: 0 })
    expect(folderDeleteChatNotice(Number.NaN)).toEqual({ key: 'folders.delete.chatNotice', count: 0 })
  })
})

describe('folderDeleteCounts', () => {
  const me = 'owner-1'
  // pinned_at is not an input of the helper — the fixture includes it to show pinned meetings count.
  const meetings = [
    { user_id: me,        folder_id: 'f1', pinned_at: null },
    { user_id: me,        folder_id: 'f1', pinned_at: '2026-10-01T00:00:00Z' },
    { user_id: 'editor',  folder_id: 'f1', pinned_at: null },
    { user_id: me,        folder_id: 'f2', pinned_at: null },
    { user_id: me,        folder_id: null, pinned_at: null },
  ]

  it('BUG-015: counts pinned meetings in the folder', () => {
    assert.equal(folderDeleteCounts(meetings, 'f1', me).total, 3)
  })

  it('BUG-015: only the caller\'s meetings are deletable (others move to their Uncategorized)', () => {
    const c = folderDeleteCounts(meetings, 'f1', me)
    assert.equal(c.deletable, 2)
    assert.equal(c.othersMoved, 1)
  })

  it('BUG-015: a folder holding only shared members\' meetings has nothing deletable', () => {
    assert.deepEqual(folderDeleteCounts(meetings, 'f1', 'editor'), { total: 3, deletable: 1, othersMoved: 2 })
    const onlyOthers = meetings.filter((m) => m.user_id === 'editor')
    assert.deepEqual(folderDeleteCounts(onlyOthers, 'f1', me), { total: 1, deletable: 0, othersMoved: 1 })
  })

  it('returns zeros for an empty folder', () => {
    assert.deepEqual(folderDeleteCounts(meetings, 'f9', me), { total: 0, deletable: 0, othersMoved: 0 })
  })

  it('unknown caller (not loaded yet): claims nothing about ownership', () => {
    assert.deepEqual(folderDeleteCounts(meetings, 'f1', ''), { total: 3, deletable: 0, othersMoved: 0 })
  })
})

// ── BUG-016: local meeting list after a folder delete ─────────────────────────

describe('meetingsAfterFolderDelete', () => {
  const me = 'owner-1'
  const meetings = [
    { id: 'a', user_id: me,       folder_id: 'f1' as string | null },
    { id: 'b', user_id: 'editor', folder_id: 'f1' as string | null },
    { id: 'c', user_id: me,       folder_id: 'f2' as string | null },
    { id: 'd', user_id: 'editor', folder_id: null as string | null },
  ]

  it('BUG-016: keep path drops shared members\' meetings instead of showing them as ghost rows', () => {
    const after = meetingsAfterFolderDelete(meetings, 'f1', me, false)
    assert.deepEqual(after.map((m) => [m.id, m.folder_id]), [['a', null], ['c', 'f2'], ['d', null]])
  })

  it('delete path removes every meeting of the folder', () => {
    const after = meetingsAfterFolderDelete(meetings, 'f1', me, true)
    assert.deepEqual(after.map((m) => m.id), ['c', 'd'])
  })

  it('unknown caller: keep path falls back to moving every folder meeting to Uncategorized', () => {
    const after = meetingsAfterFolderDelete(meetings, 'f1', '', false)
    assert.deepEqual(after.map((m) => [m.id, m.folder_id]), [['a', null], ['b', null], ['c', 'f2'], ['d', null]])
  })

  it('does not mutate the input', () => {
    meetingsAfterFolderDelete(meetings, 'f1', me, false)
    assert.equal(meetings[0]?.folder_id, 'f1')
  })
})
