// Unit tests for lib/access/roles.ts
// All functions are pure (no I/O). Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getMeetingRole,
  canPin,
  canEdit,
  canDelete,
  canManageShares,
} from '../lib/access/roles.js'
import type { FolderWithRole } from '../types/database.js'

const ME = 'user-me'
const OTHER = 'user-other'

const OWNED_FOLDER: FolderWithRole = {
  id: 'folder-owned', user_id: ME, name: 'Mine', position: 0,
  created_at: '', updated_at: '', myRole: 'owner', ownerUsername: null, memberCount: 0,
}
const EDITOR_FOLDER: FolderWithRole = {
  id: 'folder-editor', user_id: OTHER, name: 'Shared-E', position: 0,
  created_at: '', updated_at: '', myRole: 'editor', ownerUsername: 'alice', memberCount: 0,
}
const VIEWER_FOLDER: FolderWithRole = {
  id: 'folder-viewer', user_id: OTHER, name: 'Shared-V', position: 0,
  created_at: '', updated_at: '', myRole: 'viewer', ownerUsername: 'bob', memberCount: 0,
}

const FOLDERS = [OWNED_FOLDER, EDITOR_FOLDER, VIEWER_FOLDER]

// ── getMeetingRole ────────────────────────────────────────────────────────────

describe('getMeetingRole', () => {
  it('returns owner when current user owns the meeting', () => {
    const m = { user_id: ME, folder_id: null }
    assert.equal(getMeetingRole(m, ME, FOLDERS), 'owner')
  })

  it('returns owner when current user owns the meeting even if it has a shared folder_id', () => {
    const m = { user_id: ME, folder_id: EDITOR_FOLDER.id }
    assert.equal(getMeetingRole(m, ME, FOLDERS), 'owner')
  })

  it('returns owner when meeting is in a folder the current user owns', () => {
    const m = { user_id: OTHER, folder_id: OWNED_FOLDER.id }
    assert.equal(getMeetingRole(m, ME, FOLDERS), 'owner')
  })

  it('returns editor when meeting is in a folder shared as editor', () => {
    const m = { user_id: OTHER, folder_id: EDITOR_FOLDER.id }
    assert.equal(getMeetingRole(m, ME, FOLDERS), 'editor')
  })

  it('returns viewer when meeting is in a folder shared as viewer', () => {
    const m = { user_id: OTHER, folder_id: VIEWER_FOLDER.id }
    assert.equal(getMeetingRole(m, ME, FOLDERS), 'viewer')
  })

  it('returns viewer when folder_id does not match any accessible folder', () => {
    const m = { user_id: OTHER, folder_id: 'unknown-folder' }
    assert.equal(getMeetingRole(m, ME, FOLDERS), 'viewer')
  })

  it('returns viewer when meeting has no folder and is not owned by current user', () => {
    const m = { user_id: OTHER, folder_id: null }
    assert.equal(getMeetingRole(m, ME, FOLDERS), 'viewer')
  })
})

// ── canPin ────────────────────────────────────────────────────────────────────

describe('canPin', () => {
  it('allows pinning by meeting owner', () => {
    assert.equal(canPin({ user_id: ME }, ME), true)
  })

  it('denies pinning by non-owner (editor or viewer)', () => {
    assert.equal(canPin({ user_id: OTHER }, ME), false)
  })
})

// ── canEdit ───────────────────────────────────────────────────────────────────

describe('canEdit', () => {
  it('owner can edit', () => { assert.equal(canEdit('owner'), true) })
  it('editor can edit', () => { assert.equal(canEdit('editor'), true) })
  it('viewer cannot edit', () => { assert.equal(canEdit('viewer'), false) })
})

// ── canDelete ─────────────────────────────────────────────────────────────────

describe('canDelete', () => {
  it('owner can delete', () => { assert.equal(canDelete('owner'), true) })
  it('editor can delete', () => { assert.equal(canDelete('editor'), true) })
  it('viewer cannot delete', () => { assert.equal(canDelete('viewer'), false) })
})

// ── canManageShares ───────────────────────────────────────────────────────────

describe('canManageShares', () => {
  it('folder owner can manage shares', () => {
    assert.equal(canManageShares({ user_id: ME }, ME), true)
  })

  it('non-owner cannot manage shares even if editor', () => {
    assert.equal(canManageShares({ user_id: OTHER }, ME), false)
  })
})
