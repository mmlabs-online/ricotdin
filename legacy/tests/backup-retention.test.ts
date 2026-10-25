// Unit tests for DB backup naming + retention (OPS-03) — pure, no I/O.
// Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BACKUP_PREFIX,
  backupObjectKey,
  parseBackupTimestamp,
  selectExpiredBackups,
} from '../lib/backup/retention.js'

const DAY = 24 * 60 * 60 * 1000
const at = (iso: string) => new Date(iso)

describe('backupObjectKey', () => {
  it('uses the db/ prefix, a UTC minute timestamp and the .tar.gz.age suffix', () => {
    assert.equal(BACKUP_PREFIX, 'db/')
    assert.equal(backupObjectKey(at('2026-10-22T02:05:59.999Z')), 'db/ricotdin-db-20261022T0205Z.tar.gz.age')
  })
  it('is UTC regardless of the local timezone offset in the input', () => {
    assert.equal(backupObjectKey(at('2026-10-22T09:05:00+07:00')), 'db/ricotdin-db-20261022T0205Z.tar.gz.age')
  })
  it('round-trips through parseBackupTimestamp (minute precision)', () => {
    const d = at('2026-01-03T04:07:00Z')
    assert.equal(parseBackupTimestamp(backupObjectKey(d)), d.getTime())
  })
})

describe('parseBackupTimestamp', () => {
  it('returns null for keys that are not backups', () => {
    for (const k of [
      '',
      'db/',
      'db/notes.txt',
      'ricotdin-db-20261022T0205Z.tar.gz.age',          // missing prefix
      'db/ricotdin-db-20261022T0205Z.tar.gz',            // not encrypted
      'db/ricotdin-db-20261022T0205.tar.gz.age',         // no Z
      'db/sub/ricotdin-db-20261022T0205Z.tar.gz.age',    // nested
      'db/ricotdin-db-20261322T0205Z.tar.gz.age',        // month 13
      'db/ricotdin-db-20260231T0205Z.tar.gz.age',        // Feb 31
      'db/ricotdin-db-20261022T2561Z.tar.gz.age',        // 25:61
    ]) {
      assert.equal(parseBackupTimestamp(k), null, k)
    }
  })
})

describe('selectExpiredBackups', () => {
  const now = at('2026-10-22T02:00:00Z').getTime()
  const key = (daysAgo: number) => backupObjectKey(new Date(now - daysAgo * DAY))

  it('deletes backups strictly older than the retention window', () => {
    const keys = [key(1), key(29), key(31), key(45)]
    assert.deepEqual(selectExpiredBackups(keys, now, 30).sort(), [key(31), key(45)].sort())
  })
  it('keeps a backup exactly at the boundary', () => {
    assert.deepEqual(selectExpiredBackups([key(30), key(0)], now, 30), [])
  })
  it('never deletes the newest backup, even if every backup is old', () => {
    const keys = [key(40), key(50), key(60)]
    const expired = selectExpiredBackups(keys, now, 30)
    assert.deepEqual(expired.sort(), [key(50), key(60)].sort())
    assert.ok(!expired.includes(key(40)))
  })
  it('ignores objects that do not match the backup pattern', () => {
    const keys = ['db/readme.txt', 'other/ricotdin-db-20200101T0000Z.tar.gz.age', key(1), key(90)]
    assert.deepEqual(selectExpiredBackups(keys, now, 30), [key(90)])
  })
  it('retentionDays < 1 or non-integer → deletes nothing', () => {
    const keys = [key(1), key(90)]
    for (const d of [0, -5, 1.5, Number.NaN]) {
      assert.deepEqual(selectExpiredBackups(keys, now, d), [], String(d))
    }
  })
  it('empty list → nothing', () => {
    assert.deepEqual(selectExpiredBackups([], now, 30), [])
  })
})
