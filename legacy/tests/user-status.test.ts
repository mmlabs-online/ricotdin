// Unit tests for deriveUserStatus — the 3-way account status helper.
// Distinguishes 'unverified' (signed up, email not yet verified) from
// 'disabled' (admin disabled the account) and 'active'.
//
// Pure, no I/O. Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deriveUserStatus } from '../lib/admin/userStatus.js'

const NOW = new Date('2026-06-23T12:00:00Z')
const PAST = '2026-06-01T00:00:00Z'
const FAR_FUTURE = '2126-06-01T00:00:00Z' // ban ~100 years out

describe('deriveUserStatus', () => {
  it('not banned + email confirmed → active', () => {
    assert.equal(deriveUserStatus({ bannedUntil: null, emailConfirmedAt: PAST, now: NOW }), 'active')
    assert.equal(deriveUserStatus({ bannedUntil: undefined, emailConfirmedAt: PAST, now: NOW }), 'active')
  })

  it('not banned + email NOT confirmed → unverified', () => {
    assert.equal(deriveUserStatus({ bannedUntil: null, emailConfirmedAt: null, now: NOW }), 'unverified')
    assert.equal(deriveUserStatus({ bannedUntil: undefined, emailConfirmedAt: undefined, now: NOW }), 'unverified')
  })

  it('banned → disabled (takes precedence over verification state)', () => {
    assert.equal(deriveUserStatus({ bannedUntil: FAR_FUTURE, emailConfirmedAt: PAST, now: NOW }), 'disabled')
    assert.equal(deriveUserStatus({ bannedUntil: FAR_FUTURE, emailConfirmedAt: null, now: NOW }), 'disabled')
  })

  it('expired ban is not disabled — falls through to verification state', () => {
    assert.equal(deriveUserStatus({ bannedUntil: PAST, emailConfirmedAt: PAST, now: NOW }), 'active')
    assert.equal(deriveUserStatus({ bannedUntil: PAST, emailConfirmedAt: null, now: NOW }), 'unverified')
  })

  it('ban exactly at now is not considered banned (strict greater-than)', () => {
    const at = NOW.toISOString()
    assert.equal(deriveUserStatus({ bannedUntil: at, emailConfirmedAt: PAST, now: NOW }), 'active')
  })
})
