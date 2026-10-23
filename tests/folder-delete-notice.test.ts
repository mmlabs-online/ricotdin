// Unit tests for the folder delete confirm-panel notice (BUG-014).
//
// Deleting a folder cascades away its folder-scoped chat sessions for every user
// (by design, see BUG-013); both confirm panels must say so.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { folderDeleteChatNotice } from '../lib/folders/deleteNotice.js'

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
