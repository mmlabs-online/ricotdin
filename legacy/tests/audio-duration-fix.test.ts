// Unit tests for the seekable-audio duration fix — all pure, no I/O.
//
// Background: MediaRecorder writes a live-mode WebM whose Segment Info carries an
// unknown Duration and no Cues, so <audio>.duration is Infinity and the browser
// cannot seek. The "render hack" forces the browser to scan the stream so that a
// real duration and a full seekable range become available.
//
// Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  HACK_SEEK_TARGET,
  needsDurationFix,
  isRecoveredDuration,
  resolveDuration,
  shouldRunDurationFix,
} from '../lib/audio/durationFix.js'
import { coerceConfigBool } from '../lib/admin/config.js'

// ── HACK_SEEK_TARGET ─────────────────────────────────────────────────────────

describe('HACK_SEEK_TARGET', () => {
  it('is a finite number far beyond any plausible recording length', () => {
    assert.ok(Number.isFinite(HACK_SEEK_TARGET))
    assert.ok(HACK_SEEK_TARGET > 1e30)
  })
})

// ── needsDurationFix ─────────────────────────────────────────────────────────

describe('needsDurationFix', () => {
  it('returns true for Infinity (the MediaRecorder WebM case)', () => {
    assert.equal(needsDurationFix(Infinity), true)
  })

  it('returns true for NaN (metadata not parsed yet)', () => {
    assert.equal(needsDurationFix(NaN), true)
  })

  it('returns true for zero or negative durations', () => {
    assert.equal(needsDurationFix(0), true)
    assert.equal(needsDurationFix(-1), true)
  })

  it('returns true for null/undefined', () => {
    assert.equal(needsDurationFix(null), true)
    assert.equal(needsDurationFix(undefined), true)
  })

  it('returns false for a real duration (seekable file — hack not needed)', () => {
    assert.equal(needsDurationFix(2626), false)
    assert.equal(needsDurationFix(0.5), false)
  })
})

// ── isRecoveredDuration ──────────────────────────────────────────────────────

describe('isRecoveredDuration', () => {
  it('is true once the browser reports a finite positive duration', () => {
    assert.equal(isRecoveredDuration(2626), true)
  })

  it('is false while duration is still unknown', () => {
    assert.equal(isRecoveredDuration(Infinity), false)
    assert.equal(isRecoveredDuration(NaN), false)
    assert.equal(isRecoveredDuration(0), false)
  })

  it('is the exact inverse of needsDurationFix', () => {
    for (const d of [Infinity, NaN, 0, -3, 0.001, 42, 2626]) {
      assert.equal(isRecoveredDuration(d), !needsDurationFix(d), `mismatch for ${d}`)
    }
  })
})

// ── shouldRunDurationFix ─────────────────────────────────────────────────────

describe('shouldRunDurationFix', () => {
  it('runs when enabled, duration is unknown, and it has not run yet', () => {
    assert.equal(shouldRunDurationFix({ enabled: true, duration: Infinity, alreadyRan: false }), true)
  })

  it('does not run when the admin flag is off', () => {
    assert.equal(shouldRunDurationFix({ enabled: false, duration: Infinity, alreadyRan: false }), false)
  })

  it('does not run for an already-seekable file even when enabled', () => {
    assert.equal(shouldRunDurationFix({ enabled: true, duration: 2626, alreadyRan: false }), false)
  })

  it('never runs twice for the same source', () => {
    assert.equal(shouldRunDurationFix({ enabled: true, duration: Infinity, alreadyRan: true }), false)
  })
})

// ── resolveDuration ──────────────────────────────────────────────────────────

describe('resolveDuration', () => {
  it('prefers the browser-reported duration when it is real', () => {
    assert.equal(resolveDuration(2626, 2600), 2626)
  })

  it('falls back to meetings.duration_seconds when the element reports Infinity', () => {
    assert.equal(resolveDuration(Infinity, 2626), 2626)
  })

  it('falls back when the element reports NaN', () => {
    assert.equal(resolveDuration(NaN, 2626), 2626)
  })

  it('returns null when neither source has a usable value', () => {
    assert.equal(resolveDuration(Infinity, null), null)
    assert.equal(resolveDuration(NaN, 0), null)
  })
})

// ── coerceConfigBool (app_config jsonb → boolean) ────────────────────────────

describe('coerceConfigBool', () => {
  it('passes through real booleans', () => {
    assert.equal(coerceConfigBool(true, false), true)
    assert.equal(coerceConfigBool(false, true), false)
  })

  it('accepts the string forms the config editor produces', () => {
    assert.equal(coerceConfigBool('true', false), true)
    assert.equal(coerceConfigBool('TRUE', false), true)
    assert.equal(coerceConfigBool('false', true), false)
  })

  it('accepts numeric 1/0', () => {
    assert.equal(coerceConfigBool(1, false), true)
    assert.equal(coerceConfigBool(0, true), false)
  })

  it('returns the fallback for null, undefined, and unparseable values', () => {
    assert.equal(coerceConfigBool(null, false), false)
    assert.equal(coerceConfigBool(undefined, true), true)
    assert.equal(coerceConfigBool('maybe', false), false)
    assert.equal(coerceConfigBool({}, true), true)
  })
})
