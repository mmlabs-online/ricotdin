// Print a JSON snapshot of feature progress from ai-instruction/tracking.md.
// Read-only; reuses the seeder's parser so the numbers match /admin/features seeding.
// Used by the Project Status Analyst agent and the /copilot skill.
//
// Usage:
//   npx tsx scripts/backlog-snapshot.ts

import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseTrackingMd } from '../lib/features/parser.js'

const TRACKING_FILE = path.join(process.cwd(), 'ai-instruction', 'tracking.md')

const rows = [...parseTrackingMd(fs.readFileSync(TRACKING_FILE, 'utf-8')).values()]
const done = new Set(rows.filter((r) => r.is_done).map((r) => r.feature_code))

const modules: Record<string, { done: number; total: number }> = {}
for (const r of rows) {
  const prefix = r.feature_code.split('-')[0]
  modules[prefix] ??= { done: 0, total: 0 }
  modules[prefix].total++
  if (r.is_done) modules[prefix].done++
}

const open = rows
  .filter((r) => !r.is_done)
  .map((r) => ({
    code: r.feature_code,
    description: r.description,
    tags: r.note_tags,
    priority: r.priority,
    blocked_by: r.depends_on.filter((d) => !done.has(d)),
  }))

console.log(
  JSON.stringify({ done: done.size, total: rows.length, modules, open }, null, 2),
)
