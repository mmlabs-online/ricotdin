// Unit tests for the recording notice (COM-01) — pure, no I/O.
// Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  RECORDING_NOTICE_TTL_MS,
  RECORDING_NOTICE_STORAGE_KEY,
  isNoticeAckFresh,
  parseStoredAck,
  VERBAL_NOTICE_SCRIPT,
} from '../lib/consent/recordingNotice.js'
import { CLIENT_EVENT_TYPES, validateEventType } from '../lib/activity/types.js'

const HOUR = 60 * 60 * 1000

describe('recording notice constants', () => {
  it('is re-shown at least twice a day (not remembered forever)', () => {
    assert.equal(RECORDING_NOTICE_TTL_MS, 12 * HOUR)
  })
  it('has a storage key and a non-empty verbal script', () => {
    assert.ok(RECORDING_NOTICE_STORAGE_KEY.length > 0)
    assert.match(VERBAL_NOTICE_SCRIPT, /record/i)
  })
})

describe('isNoticeAckFresh', () => {
  const now = Date.UTC(2026, 9, 21, 12, 0, 0)
  it('no previous acknowledgement → not fresh (show the notice)', () => {
    assert.equal(isNoticeAckFresh(null, now), false)
  })
  it('acknowledged a minute ago → fresh', () => {
    assert.equal(isNoticeAckFresh(now - 60_000, now), true)
  })
  it('acknowledged exactly at the TTL → not fresh', () => {
    assert.equal(isNoticeAckFresh(now - RECORDING_NOTICE_TTL_MS, now), false)
  })
  it('acknowledged in the future (clock skew / tampering) → not fresh', () => {
    assert.equal(isNoticeAckFresh(now + 60_000, now), false)
  })
})

describe('parseStoredAck', () => {
  it('parses a stored millisecond timestamp', () => {
    assert.equal(parseStoredAck('1761048000000'), 1761048000000)
  })
  it('missing / malformed values → null (show the notice)', () => {
    for (const v of [null, '', 'abc', '-5', '1.5', '0', 'NaN']) {
      assert.equal(parseStoredAck(v), null, String(v))
    }
  })
})

describe('recording_notice_ack activity event', () => {
  it('is an allowed event type the browser may submit', () => {
    assert.equal(validateEventType('recording_notice_ack'), true)
    assert.equal(CLIENT_EVENT_TYPES.has('recording_notice_ack'), true)
  })
})
