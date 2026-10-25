import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { resolveSharedPath, sharedSourcePath } from '../lib/paths/shared'

// ARC-00: v1 lives in legacy/, while ai-instruction/ stays at the repo root.
// Commands run with cwd = legacy/ (local) or /app (Docker image, ai-gen copied in).

const ROOT = path.resolve('/repo')
const LEGACY = path.join(ROOT, 'legacy')

test('ARC-00: finds ai-instruction in the parent when cwd is legacy/', () => {
  const target = path.join(ROOT, 'ai-instruction', 'tracking.md')
  const exists = (p: string) => p === path.join(ROOT, 'ai-instruction')
  assert.equal(resolveSharedPath(['ai-instruction', 'tracking.md'], LEGACY, exists), target)
})

test('ARC-00: prefers cwd when ai-instruction is there (Docker image /app)', () => {
  const app = path.resolve('/app')
  const exists = (p: string) => p === path.join(app, 'ai-instruction')
  assert.equal(
    resolveSharedPath(['ai-instruction', 'ai-gen', 'generate-meeting.md'], app, exists),
    path.join(app, 'ai-instruction', 'ai-gen', 'generate-meeting.md'),
  )
})

test('ARC-00: prefers cwd over parent when both exist', () => {
  const exists = () => true
  assert.equal(
    resolveSharedPath(['ai-instruction'], LEGACY, exists),
    path.join(LEGACY, 'ai-instruction'),
  )
})

test('ARC-00: falls back to the cwd path when neither exists (caller reports ENOENT as before)', () => {
  const exists = () => false
  assert.equal(
    resolveSharedPath(['ai-instruction', 'tracking.md'], LEGACY, exists),
    path.join(LEGACY, 'ai-instruction', 'tracking.md'),
  )
})

test('ARC-00: sharedSourcePath keeps DB source_path repo-relative with forward slashes', () => {
  const file = path.join(ROOT, 'ai-instruction', 'features', 'feature-Recording-REC.md')
  const dir = path.join(ROOT, 'ai-instruction')
  assert.equal(sharedSourcePath(file, dir), 'ai-instruction/features/feature-Recording-REC.md')
})
