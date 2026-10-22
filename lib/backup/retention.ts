// DB backup object naming + retention (OPS-03). Pure; tested in tests/backup-retention.test.ts.
//
// Backups live in a dedicated R2 bucket as `db/ricotdin-db-<yyyyMMdd>T<HHmm>Z.tar.gz.age`
// (UTC, minute precision). Prune deletes backups strictly older than the retention window,
// but never the newest backup and never an object whose name doesn't match the pattern.

export const BACKUP_PREFIX = 'db/'

const KEY_RE = /^db\/ricotdin-db-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z\.tar\.gz\.age$/
const DAY_MS = 24 * 60 * 60 * 1000

const pad = (n: number) => String(n).padStart(2, '0')

export function backupObjectKey(date: Date): string {
  const stamp =
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}Z`
  return `${BACKUP_PREFIX}ricotdin-db-${stamp}.tar.gz.age`
}

/** Epoch ms encoded in a backup key, or null when the key is not a (valid) backup. */
export function parseBackupTimestamp(key: string): number | null {
  const m = KEY_RE.exec(key)
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  const ms = Date.UTC(y, mo - 1, d, h, mi)
  const back = new Date(ms)
  // Reject rollovers such as month 13, Feb 31 or 25:61.
  if (
    back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d ||
    back.getUTCHours() !== h || back.getUTCMinutes() !== mi
  ) return null
  return ms
}

/** Keys to delete: backups strictly older than `retentionDays`, never the newest backup. */
export function selectExpiredBackups(keys: string[], nowMs: number, retentionDays: number): string[] {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) return []
  const backups = keys
    .map((key) => ({ key, ts: parseBackupTimestamp(key) }))
    .filter((b): b is { key: string; ts: number } => b.ts !== null)
  if (backups.length === 0) return []
  const newest = backups.reduce((a, b) => (b.ts > a.ts ? b : a))
  const cutoff = nowMs - retentionDays * DAY_MS
  return backups.filter((b) => b !== newest && b.ts < cutoff).map((b) => b.key)
}
