// Unit tests for the folder delete confirm-panel notice (BUG-014) and counts (BUG-015).
//
// Deleting a folder cascades away its folder-scoped chat sessions for every user
// (by design, see BUG-013); both confirm panels must say so.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { folderDeleteChatNotice, folderDeleteCounts } from '../lib/folders/deleteNotice.js'

describe('folderDeleteChatNotice', () => {
  it('BUG-014: warns that folder chat history is deleted (unshared folder)', () => {
    const notice = folderDeleteChatNotice(0)
    assert.match(notice, /chat history/i)
    assert.match(notice, /deleted/i)
    assert.doesNotMatch(notice, /member/i)
  })

  it('BUG-014: says it is deleted for everyone, including shared members', () => {
    assert.match(folderDeleteChatNotice(1), /for everyone/)
    assert.match(folderDeleteChatNotice(1), /its 1 shared member\b/)
    assert.match(folderDeleteChatNotice(3), /its 3 shared members\b/)
  })

  it('treats negative, fractional and non-finite counts defensively', () => {
    assert.doesNotMatch(folderDeleteChatNotice(-1), /member/i)
    assert.match(folderDeleteChatNotice(2.7), /its 2 shared members\b/)
    assert.doesNotMatch(folderDeleteChatNotice(NaN), /NaN|member/)
  })
})

// ── BUG-015: meeting counts in the folder-card delete panel ───────────────────

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
