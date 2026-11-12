// Pure helpers for computing meeting and storage usage statistics.
// No I/O — fully unit-testable in isolation.

export interface MeetingRow {
  status: string
  created_at: string
}

export interface MeetingStats {
  total: number
  byStatus: Record<string, number>
  failureRate: number
  last7Days: number
  last30Days: number
}

export function computeMeetingStats(rows: MeetingRow[], now: Date = new Date()): MeetingStats {
  const total = rows.length
  const byStatus: Record<string, number> = {}

  const ms7  = 7  * 24 * 60 * 60 * 1000
  const ms30 = 30 * 24 * 60 * 60 * 1000
  let last7  = 0
  let last30 = 0

  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
    const age = now.getTime() - new Date(row.created_at).getTime()
    if (age <= ms7)  last7++
    if (age <= ms30) last30++
  }

  const failed = byStatus['failed'] ?? 0
  const failureRate = total === 0 ? 0 : failed / total

  return { total, byStatus, failureRate, last7Days: last7, last30Days: last30 }
}

export interface StorageFile {
  metadata: { size?: number } | null
}

export interface StorageStats {
  totalBytes: number
  fileCount: number
}

export function computeStorageStats(files: StorageFile[]): StorageStats {
  let totalBytes = 0
  let fileCount  = 0
  for (const f of files) {
    if (f.metadata != null && typeof f.metadata.size === 'number') {
      totalBytes += f.metadata.size
      fileCount++
    }
  }
  return { totalBytes, fileCount }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  const gb = mb / 1024
  return `${gb.toFixed(2)} GB`
}
