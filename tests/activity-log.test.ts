// Unit tests for activity-log pure helpers.
//
// Scenarios:
//   1. validateEventType — whitelist; meeting_viewed is NEVER allowed.
//   2. parseActivityQueryParams — correct defaults + parsing.
//   3. isCallerOwn — client endpoint must reject cross-user logging.
//   4. meeting_viewed is never in the allowed set (regression guard).
//
// Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { validateEventType, ALLOWED_EVENT_TYPES } from '../lib/activity/types.js'
import { parseActivityQueryParams } from '../lib/activity/parse.js'
import { isCallerOwn } from '../lib/activity/guards.js'

// ---------------------------------------------------------------------------
// 1. validateEventType
// ---------------------------------------------------------------------------

describe('validateEventType', () => {
  it('accepts login', () => {
    assert.equal(validateEventType('login'), true)
  })

  it('accepts logout', () => {
    assert.equal(validateEventType('logout'), true)
  })

  it('accepts record_start (best-effort client event)', () => {
    assert.equal(validateEventType('record_start'), true)
  })

  it('accepts record_stop (best-effort client event)', () => {
    assert.equal(validateEventType('record_stop'), true)
  })

  it('accepts meeting_created', () => {
    assert.equal(validateEventType('meeting_created'), true)
  })

  it('accepts processing_done', () => {
    assert.equal(validateEventType('processing_done'), true)
  })

  it('accepts processing_failed', () => {
    assert.equal(validateEventType('processing_failed'), true)
  })

  it('accepts chat_message', () => {
    assert.equal(validateEventType('chat_message'), true)
  })

  it('accepts meeting_deleted', () => {
    assert.equal(validateEventType('meeting_deleted'), true)
  })

  it('accepts meeting_shared (schema ready, future hook)', () => {
    assert.equal(validateEventType('meeting_shared'), true)
  })

  it('accepts meeting_unshared (schema ready, future hook)', () => {
    assert.equal(validateEventType('meeting_unshared'), true)
  })

  it('accepts recording_notice_ack (COM-01 client event)', () => {
    assert.equal(validateEventType('recording_notice_ack'), true)
  })

  it('rejects unknown event type', () => {
    assert.equal(validateEventType('some_random_event'), false)
  })

  it('rejects empty string', () => {
    assert.equal(validateEventType(''), false)
  })
})

// ---------------------------------------------------------------------------
// 2. meeting_viewed MUST NEVER appear in the allowed set (regression guard)
// ---------------------------------------------------------------------------

describe('meeting_viewed is intentionally excluded', () => {
  it('validateEventType rejects meeting_viewed', () => {
    assert.equal(validateEventType('meeting_viewed'), false)
  })

  it('meeting_viewed is not in ALLOWED_EVENT_TYPES set', () => {
    assert.equal(ALLOWED_EVENT_TYPES.has('meeting_viewed'), false)
  })
})

// ---------------------------------------------------------------------------
// 3. parseActivityQueryParams
// ---------------------------------------------------------------------------

describe('parseActivityQueryParams', () => {
  it('returns defaults when no params are set', () => {
    const p = parseActivityQueryParams(new URLSearchParams(''))
    assert.equal(p.page, 1)
    assert.equal(p.perPage, 20)
    assert.equal(p.userId, null)
    assert.equal(p.eventType, null)
    assert.equal(p.from, null)
    assert.equal(p.to, null)
  })

  it('parses page and perPage', () => {
    const p = parseActivityQueryParams(new URLSearchParams('page=3&perPage=50'))
    assert.equal(p.page, 3)
    assert.equal(p.perPage, 50)
  })

  it('clamps page to minimum 1', () => {
    const p = parseActivityQueryParams(new URLSearchParams('page=0'))
    assert.equal(p.page, 1)
  })

  it('clamps perPage to maximum 100', () => {
    const p = parseActivityQueryParams(new URLSearchParams('perPage=500'))
    assert.equal(p.perPage, 100)
  })

  it('parses userId filter', () => {
    const p = parseActivityQueryParams(new URLSearchParams('userId=abc-123'))
    assert.equal(p.userId, 'abc-123')
  })

  it('parses eventType filter', () => {
    const p = parseActivityQueryParams(new URLSearchParams('eventType=login'))
    assert.equal(p.eventType, 'login')
  })

  it('parses from/to date filters', () => {
    const p = parseActivityQueryParams(new URLSearchParams('from=2025-01-01&to=2025-12-31'))
    assert.equal(p.from, '2025-01-01')
    assert.equal(p.to, '2025-12-31')
  })
})

// ---------------------------------------------------------------------------
// 4. isCallerOwn — client endpoint must refuse cross-user event logging
// ---------------------------------------------------------------------------

describe('isCallerOwn', () => {
  it('returns true when caller matches the requested userId', () => {
    assert.equal(isCallerOwn('user-aaa', 'user-aaa'), true)
  })

  it('returns false when userId differs from caller (blocks cross-user logging)', () => {
    assert.equal(isCallerOwn('user-aaa', 'user-bbb'), false)
  })

  it('returns false when requestedUserId is empty', () => {
    assert.equal(isCallerOwn('user-aaa', ''), false)
  })
})
