// ARC-00: v1 lives in legacy/, but shared folders (ai-instruction/) stay at the repo root.
// v1 commands run with cwd = legacy/ locally, and cwd = /app in the Docker image (where
// ai-instruction/ai-gen is copied next to the app). Pure: the existence check is injected.

import path from 'node:path'

/**
 * Resolve a repo-shared path such as ['ai-instruction', 'tracking.md'].
 * Looks for the first segment in `cwd`, then in its parent. Falls back to the `cwd`
 * candidate so a missing file still fails with the usual ENOENT at the caller.
 */
export function resolveSharedPath(
  segments: string[],
  cwd: string,
  exists: (dir: string) => boolean,
): string {
  const [top] = segments
  for (const base of [cwd, path.dirname(cwd)]) {
    if (exists(path.join(base, top))) return path.join(base, ...segments)
  }
  return path.join(cwd, ...segments)
}

/**
 * Repo-relative, forward-slash path of a file inside a shared folder, e.g.
 * 'ai-instruction/features/x.md' — independent of where the command ran from.
 */
export function sharedSourcePath(file: string, sharedDir: string): string {
  return path.relative(path.dirname(sharedDir), file).replace(/\\/g, '/')
}
