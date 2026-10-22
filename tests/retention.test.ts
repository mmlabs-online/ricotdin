// Unit tests for audio retention purge pure logic (PRV-02) — all pure, no I/O.
// Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseRetentionDays,
  retentionCutoff,
  isPurgeEligible,
  canReprocess,
  audioState,
  isOwnedAudioKey,
  ownedAudioPath,
  ownedAudioDeleteItems,
  RETENTION_SETTING_KEY,
  PURGE_INTERVAL_MS,
  PURGE_BATCH_LIMIT,
  MAX_RETENTION_DAYS,
} from '../lib/retention/policy.js'

const DAY = 24 * 60 * 60 * 1000

// ── constants ───────────────────────────────────────────────────────────────

describe('retention constants', () => {
  it('reads the existing app_config key', () => {
    assert.equal(RETENTION_SETTING_KEY, 'storage.audio_retention_days')
  })
  it('runs daily and in bounded batches', () => {
    assert.equal(PURGE_INTERVAL_MS, DAY)
    assert.ok(PURGE_BATCH_LIMIT > 0 && PURGE_BATCH_LIMIT <= 1000)
  })
})

// ── parseRetentionDays ──────────────────────────────────────────────────────

describe('parseRetentionDays', () => {
  it('accepts a positive integer', () => {
    assert.equal(parseRetentionDays(30), 30)
    assert.equal(parseRetentionDays(1), 1)
  })
  it('accepts a numeric string (trimmed)', () => {
    assert.equal(parseRetentionDays('30'), 30)
    assert.equal(parseRetentionDays(' 7 '), 7)
  })
  it('null / undefined = keep forever (off)', () => {
    assert.equal(parseRetentionDays(null), null)
    assert.equal(parseRetentionDays(undefined), null)
  })
  it('zero, negative, fractional, NaN, Infinity → off (never delete when unsure)', () => {
    for (const v of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '0', '-3', '2.5', 'abc', '', '30d']) {
      assert.equal(parseRetentionDays(v), null, `value ${String(v)}`)
    }
  })
  it('non-number types → off', () => {
    for (const v of [true, false, {}, [], [30]]) {
      assert.equal(parseRetentionDays(v), null)
    }
  })
  it('values above MAX_RETENTION_DAYS → off', () => {
    assert.equal(parseRetentionDays(MAX_RETENTION_DAYS), MAX_RETENTION_DAYS)
    assert.equal(parseRetentionDays(MAX_RETENTION_DAYS + 1), null)
  })
})

// ── retentionCutoff ─────────────────────────────────────────────────────────

describe('retentionCutoff', () => {
  it('is exactly `days` days before now', () => {
    const now = Date.UTC(2026, 9, 21, 12, 0, 0)
    assert.equal(retentionCutoff(now, 30).getTime(), now - 30 * DAY)
    assert.equal(retentionCutoff(now, 1).toISOString(), '2026-10-20T12:00:00.000Z')
  })
})

// ── isPurgeEligible ─────────────────────────────────────────────────────────

describe('isPurgeEligible', () => {
  const cutoff = new Date('2026-10-01T00:00:00.000Z')
  const old = { status: 'done', audio_path: 'u/m.webm', created_at: '2026-09-01T00:00:00.000Z' }

  it('done + has audio + created before cutoff → eligible', () => {
    assert.equal(isPurgeEligible(old, cutoff), true)
  })
  it('created exactly at the cutoff → not eligible (strictly older only)', () => {
    assert.equal(isPurgeEligible({ ...old, created_at: cutoff.toISOString() }, cutoff), false)
  })
  it('created after the cutoff → not eligible', () => {
    assert.equal(isPurgeEligible({ ...old, created_at: '2026-10-02T00:00:00.000Z' }, cutoff), false)
  })
  it('never purges a meeting that is not done (audio may still be needed)', () => {
    for (const status of ['pending', 'processing', 'failed']) {
      assert.equal(isPurgeEligible({ ...old, status }, cutoff), false, status)
    }
  })
  it('no audio (null / empty) → not eligible', () => {
    assert.equal(isPurgeEligible({ ...old, audio_path: null }, cutoff), false)
    assert.equal(isPurgeEligible({ ...old, audio_path: '' }, cutoff), false)
  })
  it('unparseable created_at → not eligible', () => {
    assert.equal(isPurgeEligible({ ...old, created_at: 'not-a-date' }, cutoff), false)
  })
})

// ── canReprocess ────────────────────────────────────────────────────────────

describe('canReprocess', () => {
  it('true only when an audio_path is present', () => {
    assert.equal(canReprocess({ audio_path: 'u/m.webm' }), true)
  })
  it('PRV-02: false once audio was purged — reprocess/requeue would wipe the transcript', () => {
    assert.equal(canReprocess({ audio_path: null }), false)
    assert.equal(canReprocess({ audio_path: '' }), false)
  })
})

// ── audioState ──────────────────────────────────────────────────────────────

describe('audioState', () => {
  it('available when audio_path is set', () => {
    assert.equal(audioState({ audio_path: 'u/m.webm', audio_purged_at: null }), 'available')
  })
  it('purged when audio_path is gone and audio_purged_at is set', () => {
    assert.equal(audioState({ audio_path: null, audio_purged_at: '2026-10-21T00:00:00Z' }), 'purged')
  })
  it('none when there never was audio', () => {
    assert.equal(audioState({ audio_path: null, audio_purged_at: null }), 'none')
    assert.equal(audioState({ audio_path: null }), 'none')
  })
})

// ── isOwnedAudioKey ─────────────────────────────────────────────────────────
// Storage keys are always `${user_id}/${meeting_id}<.ext>` (app/api/meetings route,
// /uploaded transcode). Users can UPDATE their meetings row (RLS), so a service-role delete
// must never trust audio_path blindly — it must point at THIS meeting's own object.

describe('isOwnedAudioKey', () => {
  const u = '11111111-1111-1111-1111-111111111111'
  const m = '22222222-2222-2222-2222-222222222222'

  it('accepts the meeting\'s own key, with or without an extension', () => {
    assert.equal(isOwnedAudioKey(`${u}/${m}.webm`, u, m), true)
    assert.equal(isOwnedAudioKey(`${u}/${m}.mp3`, u, m), true)
    assert.equal(isOwnedAudioKey(`${u}/${m}`, u, m), true)
  })
  it('SEC (PRV-02 review): rejects another user\'s object', () => {
    assert.equal(isOwnedAudioKey(`99999999-9999-9999-9999-999999999999/${m}.webm`, u, m), false)
  })
  it('SEC: rejects another meeting\'s object of the same user', () => {
    assert.equal(isOwnedAudioKey(`${u}/33333333-3333-3333-3333-333333333333.webm`, u, m), false)
  })
  it('SEC: rejects prefix tricks, traversal and nesting', () => {
    for (const key of [
      `${u}/${m}x.webm`,
      `${u}/${m}.webm/../other.webm`,
      `${u}/${m}/x.webm`,
      `../${u}/${m}.webm`,
      `${u}//${m}.webm`,
      `${u}/${m}.we bm`,
      `/${u}/${m}.webm`,
    ]) {
      assert.equal(isOwnedAudioKey(key, u, m), false, key)
    }
  })
  it('rejects empty inputs', () => {
    assert.equal(isOwnedAudioKey('', u, m), false)
    assert.equal(isOwnedAudioKey(`${u}/${m}.webm`, '', m), false)
    assert.equal(isOwnedAudioKey(`${u}/${m}.webm`, u, ''), false)
  })
})

// ── ownedAudioPath (BUG-003) ────────────────────────────────────────────────
// audio_path was writable by the meeting owner/editor via PostgREST, and the audio-url
// signing + pipeline download used it as-is → another user's recording could be read.

describe('ownedAudioPath', () => {
  const u = '11111111-1111-1111-1111-111111111111'
  const m = '22222222-2222-2222-2222-222222222222'
  const victim = '99999999-9999-9999-9999-999999999999/33333333-3333-3333-3333-333333333333.webm'

  it("returns the meeting's own audio key", () => {
    assert.equal(ownedAudioPath({ id: m, user_id: u, audio_path: `${u}/${m}.webm` }), `${u}/${m}.webm`)
  })
  it("BUG-003: a forged audio_path pointing at another user's recording is not signable or downloadable", () => {
    assert.equal(ownedAudioPath({ id: m, user_id: u, audio_path: victim }), null)
  })
  it('binds to both id and user_id: a rewritten user_id does not validate the old key', () => {
    assert.equal(ownedAudioPath({ id: m, user_id: '99999999-9999-9999-9999-999999999999', audio_path: `${u}/${m}.webm` }), null)
  })
  it('null / empty audio_path → null', () => {
    assert.equal(ownedAudioPath({ id: m, user_id: u, audio_path: null }), null)
    assert.equal(ownedAudioPath({ id: m, user_id: u, audio_path: '' }), null)
  })
})

// ── ownedAudioDeleteItems (BUG-004) ─────────────────────────────────────────
// Folder delete used `storage.from('recordings').remove(paths)` (Supabase bucket only), so R2
// audio was orphaned. Each item must carry its own storage provider.

describe('ownedAudioDeleteItems', () => {
  const u = '11111111-1111-1111-1111-111111111111'
  const m1 = '22222222-2222-2222-2222-222222222222'
  const m2 = '33333333-3333-3333-3333-333333333333'
  const m3 = '44444444-4444-4444-4444-444444444444'

  it("BUG-004: keeps each object's provider so R2 audio is deleted from R2", () => {
    const items = ownedAudioDeleteItems([
      { id: m1, user_id: u, audio_path: `${u}/${m1}.webm`, storage_provider: 'r2' },
      { id: m2, user_id: u, audio_path: `${u}/${m2}.mp3`, storage_provider: 'supabase' },
    ])
    assert.deepEqual(items, [
      { key: `${u}/${m1}.webm`, provider: 'r2' },
      { key: `${u}/${m2}.mp3`, provider: 'supabase' },
    ])
  })
  it('skips meetings without audio and forged (non-owned) paths', () => {
    const items = ownedAudioDeleteItems([
      { id: m1, user_id: u, audio_path: null, storage_provider: 'r2' },
      { id: m2, user_id: u, audio_path: `99999999-9999-9999-9999-999999999999/${m2}.webm`, storage_provider: 'r2' },
      { id: m3, user_id: u, audio_path: `${u}/${m3}.webm`, storage_provider: 'r2' },
    ])
    assert.deepEqual(items, [{ key: `${u}/${m3}.webm`, provider: 'r2' }])
  })
  it('empty input → empty list', () => {
    assert.deepEqual(ownedAudioDeleteItems([]), [])
  })
})
