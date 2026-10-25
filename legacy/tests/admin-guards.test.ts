// Unit tests for lib/admin/guards.ts
// Covers the 403-equivalent admin-role check and all self-action / last-admin guards.
// Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkAdminRole,
  guardRoleDemotion,
  guardDisable,
  guardDelete,
  type GuardFail,
} from '../lib/admin/guards.js'

// ---------------------------------------------------------------------------
// checkAdminRole — this is what requireAdmin uses; false → HTTP 403
// ---------------------------------------------------------------------------

describe('checkAdminRole', () => {
  it('returns true for role = admin', () => {
    assert.equal(checkAdminRole({ role: 'admin' }), true)
  })

  it('returns false for role = user (would yield HTTP 403)', () => {
    assert.equal(checkAdminRole({ role: 'user' }), false)
  })

  it('returns false when role key is absent (would yield HTTP 403)', () => {
    assert.equal(checkAdminRole({}), false)
  })

  it('returns false when role is undefined (would yield HTTP 403)', () => {
    assert.equal(checkAdminRole({ role: undefined }), false)
  })
})

// ---------------------------------------------------------------------------
// guardRoleDemotion
// ---------------------------------------------------------------------------

describe('guardRoleDemotion — promotions always pass', () => {
  it('passes when promoting user → admin', () => {
    assert.equal(guardRoleDemotion('caller', 'target', 'user', 'admin', 1).ok, true)
  })

  it('passes when role unchanged (admin → admin)', () => {
    assert.equal(guardRoleDemotion('caller', 'target', 'admin', 'admin', 2).ok, true)
  })
})

describe('guardRoleDemotion — self-demotion guard', () => {
  it('blocks demoting yourself', () => {
    const r = guardRoleDemotion('u1', 'u1', 'admin', 'user', 5)
    assert.equal(r.ok, false)
    assert.match((r as GuardFail).message, /yourself/)
  })

  it('allows another admin to be demoted (2 admins)', () => {
    const r = guardRoleDemotion('u1', 'u2', 'admin', 'user', 2)
    assert.equal(r.ok, true)
  })
})

describe('guardRoleDemotion — last-admin guard', () => {
  it('blocks demoting when only 1 admin remains', () => {
    const r = guardRoleDemotion('u1', 'u2', 'admin', 'user', 1)
    assert.equal(r.ok, false)
    assert.match((r as GuardFail).message, /last/)
  })

  it('allows demoting when 2 admins exist', () => {
    const r = guardRoleDemotion('u1', 'u2', 'admin', 'user', 2)
    assert.equal(r.ok, true)
  })

  it('allows demoting when many admins exist', () => {
    const r = guardRoleDemotion('u1', 'u2', 'admin', 'user', 10)
    assert.equal(r.ok, true)
  })
})

// ---------------------------------------------------------------------------
// guardDisable
// ---------------------------------------------------------------------------

describe('guardDisable', () => {
  it('blocks disabling yourself', () => {
    const r = guardDisable('u1', 'u1', 'user', 5)
    assert.equal(r.ok, false)
    assert.match((r as GuardFail).message, /own account/)
  })

  it('blocks disabling the last admin', () => {
    const r = guardDisable('u1', 'u2', 'admin', 1)
    assert.equal(r.ok, false)
    assert.match((r as GuardFail).message, /last/)
  })

  it('allows disabling a regular user', () => {
    assert.equal(guardDisable('u1', 'u2', 'user', 3).ok, true)
  })

  it('allows disabling an admin when 2+ admins exist', () => {
    assert.equal(guardDisable('u1', 'u2', 'admin', 2).ok, true)
  })

  it('allows disabling a regular user even if there is only 1 admin', () => {
    assert.equal(guardDisable('u1', 'u2', 'user', 1).ok, true)
  })
})

// ---------------------------------------------------------------------------
// guardDelete
// ---------------------------------------------------------------------------

describe('guardDelete', () => {
  it('blocks deleting yourself', () => {
    const r = guardDelete('u1', 'u1', 'admin', 5)
    assert.equal(r.ok, false)
    assert.match((r as GuardFail).message, /own account/)
  })

  it('blocks deleting the last admin', () => {
    const r = guardDelete('u1', 'u2', 'admin', 1)
    assert.equal(r.ok, false)
    assert.match((r as GuardFail).message, /last/)
  })

  it('allows deleting a regular user', () => {
    assert.equal(guardDelete('u1', 'u2', 'user', 5).ok, true)
  })

  it('allows deleting an admin when 2+ admins exist', () => {
    assert.equal(guardDelete('u1', 'u2', 'admin', 2).ok, true)
  })

  it('allows deleting a regular user even if admin count is 1', () => {
    assert.equal(guardDelete('u1', 'u2', 'user', 1).ok, true)
  })
})
