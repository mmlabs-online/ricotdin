// Unit tests for the recording notice (COM-01) — pure, no I/O.
// Run with: npm test

import { describe, it } from 'vitest'
import assert from '../../test/assert'
import {
  RECORDING_NOTICE_TTL_MS,
  RECORDING_NOTICE_STORAGE_KEY,
  isNoticeAckFresh,
  parseStoredAck,
} from './recordingNotice'
import en from '../../i18n/locales/en.json'
import vi from '../../i18n/locales/vi.json'

const HOUR = 60 * 60 * 1000

describe('recording notice constants', () => {
  it('is re-shown at least twice a day (not remembered forever)', () => {
    assert.equal(RECORDING_NOTICE_TTL_MS, 12 * HOUR)
  })
  it('has a storage key and a verbal script in both languages', () => {
    assert.ok(RECORDING_NOTICE_STORAGE_KEY.length > 0)
    assert.match(en.record.notice.script, /record/i)
    assert.match(vi.record.notice.script, /ghi âm/i)
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
