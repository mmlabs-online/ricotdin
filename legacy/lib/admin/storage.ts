// Pure helpers for orphan detection and storage-cleanup operations.
// No I/O — fully unit-testable in isolation.

export interface StorageFile {
  path: string
  size: number
  createdAt: string
}

/** Returns storage paths that are not referenced in the DB set. */
export function findOrphans(storagePaths: Set<string>, dbPaths: Set<string>): string[] {
  const orphans: string[] = []
  for (const p of storagePaths) {
    if (!dbPaths.has(p)) orphans.push(p)
  }
  return orphans
}

/** Returns files whose createdAt timestamp is strictly before the cutoff date. */
export function filterByAge(files: StorageFile[], cutoffDate: Date): StorageFile[] {
  return files.filter((f) => new Date(f.createdAt).getTime() < cutoffDate.getTime())
}

/**
 * Splits a flat array of paths into batches of at most batchSize items.
 * Default batch size: 100 (Supabase Storage remove() limit).
 */
export function batchPaths(paths: string[], batchSize: number = 100): string[][] {
  const batches: string[][] = []
  for (let i = 0; i < paths.length; i += batchSize) {
    batches.push(paths.slice(i, i + batchSize))
  }
  return batches
}
