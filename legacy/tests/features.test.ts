// Unit tests for the feature registry parser.
//
// All tests are pure (no I/O, no DB): they exercise the exported functions in
// lib/features/parser.ts with inline strings.
//
// Covered scenarios:
//   1. parseStatus — all three status values + edge cases
//   2. parseFeatureSection — status, user_story, content extraction
//   3. parseModuleFile — extracts features + module metadata from a mini file
//   4. parseTrackingMd — parses table rows into TrackingRow map
//   5. mergeWithTracking — tracking.md wins for is_done; partial preserved; fallback

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseStatus,
  parseFeatureSection,
  parseModuleFile,
  parseTrackingMd,
  mergeWithTracking,
} from '../lib/features/parser.js'

// ── 1. parseStatus ────────────────────────────────────────────────────────────

describe('parseStatus', () => {
  it('maps ✅ Done to done', () => {
    assert.equal(parseStatus('✅ Done'), 'done')
  })

  it('maps ✅ Done (Phase X) to done', () => {
    assert.equal(parseStatus('✅ Done (Phase 3)'), 'done')
  })

  it('maps [x] to done', () => {
    assert.equal(parseStatus('[x]'), 'done')
  })

  it('maps ❌ Not started to not_started', () => {
    assert.equal(parseStatus('❌ Not started'), 'not_started')
  })

  it('maps empty string to not_started', () => {
    assert.equal(parseStatus(''), 'not_started')
  })

  it('maps ⚠️ Partial to partial', () => {
    assert.equal(parseStatus('⚠️ Partial — some done'), 'partial')
  })

  it('maps text with "partial" (case-insensitive) to partial', () => {
    assert.equal(parseStatus('Partially done'), 'partial')
  })
})

// ── 2. parseFeatureSection ────────────────────────────────────────────────────

const SAMPLE_SECTION = `
**Status:** ✅ Done

**User Story**
As a user, I want to toggle recording and mix sources.

**Use Cases**
1. User clicks Start Recording.
2. System acquires streams.

**Frontend**
- Start/Stop buttons.

**Backend**
- Pure browser-side; no server involvement.
`

describe('parseFeatureSection', () => {
  it('extracts status correctly', () => {
    const r = parseFeatureSection('REC-01', 'Toggle recording', SAMPLE_SECTION)
    assert.equal(r.status, 'done')
  })

  it('extracts key and title', () => {
    const r = parseFeatureSection('REC-01', 'Toggle recording', SAMPLE_SECTION)
    assert.equal(r.key, 'REC-01')
    assert.equal(r.title, 'Toggle recording')
  })

  it('extracts user story', () => {
    const r = parseFeatureSection('REC-01', 'Toggle recording', SAMPLE_SECTION)
    assert.ok(r.user_story?.includes('As a user'))
    assert.ok(r.user_story?.includes('toggle recording'))
  })

  it('includes frontend and backend content', () => {
    const r = parseFeatureSection('REC-01', 'Toggle recording', SAMPLE_SECTION)
    assert.ok(r.content.includes('Use Cases'))
    assert.ok(r.content.includes('Frontend'))
    assert.ok(r.content.includes('Backend'))
  })

  it('returns null user_story when section has none', () => {
    const r = parseFeatureSection('X-01', 'No story', '**Status:** ❌ Not started\n')
    assert.equal(r.user_story, null)
  })
})

// ── 3. parseModuleFile ────────────────────────────────────────────────────────

const MINI_MODULE = `# Recording Module (REC)

**Module prefix:** REC
**Status:** ✅ Done (Phase 1)
**Key files:** \`lib/audio/capture.ts\`, \`hooks/useRecorder.ts\`

---

## Overview

The Recording module handles in-browser audio capture.

---

## Features

### REC-01 — Toggle recording
**Status:** ✅ Done

**User Story**
As a user, I want to start/stop recording.

**Use Cases**
1. Click Start.

**Frontend**
- Start button.

**Backend**
- No server involvement.

---

### REC-02 — Audio-only capture
**Status:** ✅ Done

**User Story**
As a user, I want audio only.

**Use Cases**
1. Drop video tracks.

**Frontend**
- No video shown.

**Backend**
- Handled client-side.

## Data Flow

\`\`\`
Blob → upload
\`\`\`

## Dependencies

- **Depends on:** none
- **Blocks:** PRP-01
`

describe('parseModuleFile', () => {
  it('extracts correct number of features', () => {
    const features = parseModuleFile(MINI_MODULE, 'ai-instruction/features/feature-Recording-REC.md')
    assert.equal(features.length, 2)
  })

  it('extracts module prefix and name', () => {
    const [f] = parseModuleFile(MINI_MODULE, 'test.md')
    assert.equal(f.module_prefix, 'REC')
    assert.equal(f.module_name, 'Recording')
  })

  it('extracts feature keys correctly', () => {
    const features = parseModuleFile(MINI_MODULE, 'test.md')
    assert.equal(features[0].key, 'REC-01')
    assert.equal(features[1].key, 'REC-02')
  })

  it('extracts key_files from module header', () => {
    const [f] = parseModuleFile(MINI_MODULE, 'test.md')
    assert.ok(f.key_files.some((p) => p.includes('capture.ts')))
    assert.ok(f.key_files.some((p) => p.includes('useRecorder.ts')))
  })

  it('stores module overview in metadata', () => {
    const [f] = parseModuleFile(MINI_MODULE, 'test.md')
    assert.ok(typeof f.metadata.module_overview === 'string')
    assert.ok((f.metadata.module_overview as string).includes('in-browser audio'))
  })

  it('stores source_path as provided', () => {
    const [f] = parseModuleFile(MINI_MODULE, 'ai-instruction/features/feature-Recording-REC.md')
    assert.equal(f.source_path, 'ai-instruction/features/feature-Recording-REC.md')
  })
})

// ── 4. parseTrackingMd ────────────────────────────────────────────────────────

const MINI_TRACKING = `# Feature List

| Module | Feature | Feature Code | Subfeature (User Story) | Description | Is Done? | Constraint (Depends on) | Note |
|---|---|---|---|---|---|---|---|
| Recording | Toggle recording | REC-01 | As a user, I want to toggle. | Captures audio. | \`[x]\` | REC-04 | — |
| Recording | Audio-only | REC-02 | As a user, I want audio only. | Drops video. | \`[x]\` | REC-01 | — |
| Reliability | Durable queue | REL-01 | As the system, I want durability. | Durable job queue. | \`[ ]\` | PRP-07 | **Blocker** |
| Commercialization | Consent | COM-01 | As a user, I want consent. | Recording consent. | \`[ ]\` | REC-01 | **SaaS** |
| Proposed | Speaker naming | PRO-04 | As a user, I want names. | Speaker labels. | \`[ ]\` | PRP-03 | Priority: High |
`

describe('parseTrackingMd', () => {
  it('parses all feature rows', () => {
    const map = parseTrackingMd(MINI_TRACKING)
    assert.equal(map.size, 5)
  })

  it('marks is_done=true for [x] rows', () => {
    const map = parseTrackingMd(MINI_TRACKING)
    assert.equal(map.get('REC-01')?.is_done, true)
    assert.equal(map.get('REC-02')?.is_done, true)
  })

  it('marks is_done=false for [ ] rows', () => {
    const map = parseTrackingMd(MINI_TRACKING)
    assert.equal(map.get('REL-01')?.is_done, false)
  })

  it('extracts depends_on feature codes', () => {
    const map = parseTrackingMd(MINI_TRACKING)
    assert.deepEqual(map.get('REC-01')?.depends_on, ['REC-04'])
  })

  it('tags Blocker from note column', () => {
    const map = parseTrackingMd(MINI_TRACKING)
    assert.ok(map.get('REL-01')?.note_tags.includes('Blocker'))
  })

  it('tags SaaS from note column', () => {
    const map = parseTrackingMd(MINI_TRACKING)
    assert.ok(map.get('COM-01')?.note_tags.includes('SaaS'))
  })

  it('extracts priority from note column', () => {
    const map = parseTrackingMd(MINI_TRACKING)
    assert.equal(map.get('PRO-04')?.priority, 'high')
  })

  it('extracts short description', () => {
    const map = parseTrackingMd(MINI_TRACKING)
    assert.equal(map.get('REC-01')?.description, 'Captures audio.')
  })
})

// ── 5. mergeWithTracking ──────────────────────────────────────────────────────

describe('mergeWithTracking', () => {
  const baseFeature = {
    key: 'REC-01',
    title: 'Toggle recording',
    user_story: null as string | null,
    status: 'not_started' as const,
    content: '',
    module_prefix: 'REC',
    module_name: 'Recording',
    key_files: [],
    source_path: 'test.md',
    metadata: {},
  }

  it('sets status to done when tracking says is_done=true', () => {
    const tr = { feature_code: 'REC-01', description: 'Captures audio.', user_story_fallback: 'As a user…', is_done: true, depends_on: [], note_tags: [], priority: null as null }
    const merged = mergeWithTracking(baseFeature, tr)
    assert.equal(merged.status, 'done')
  })

  it('keeps partial status when tracking says not done', () => {
    const partial = { ...baseFeature, status: 'partial' as const }
    const tr = { feature_code: 'REC-01', description: '', user_story_fallback: '', is_done: false, depends_on: [], note_tags: [], priority: null as null }
    const merged = mergeWithTracking(partial, tr)
    assert.equal(merged.status, 'partial')
  })

  it('uses tracking description', () => {
    const tr = { feature_code: 'REC-01', description: 'Short desc', user_story_fallback: '', is_done: false, depends_on: [], note_tags: [], priority: null as null }
    const merged = mergeWithTracking(baseFeature, tr)
    assert.equal(merged.description, 'Short desc')
  })

  it('falls back to tracking user_story when feature has none', () => {
    const tr = { feature_code: 'REC-01', description: '', user_story_fallback: 'As a user, fallback', is_done: false, depends_on: [], note_tags: [], priority: null as null }
    const merged = mergeWithTracking(baseFeature, tr)
    assert.equal(merged.user_story, 'As a user, fallback')
  })

  it('prefers feature user_story when present', () => {
    const withStory = { ...baseFeature, user_story: 'From file' }
    const tr = { feature_code: 'REC-01', description: '', user_story_fallback: 'From tracking', is_done: false, depends_on: [], note_tags: [], priority: null as null }
    const merged = mergeWithTracking(withStory, tr)
    assert.equal(merged.user_story, 'From file')
  })

  it('uses empty arrays when tracking is null', () => {
    const merged = mergeWithTracking(baseFeature, null)
    assert.deepEqual(merged.depends_on, [])
    assert.deepEqual(merged.note_tags, [])
    assert.equal(merged.priority, null)
  })

  it('keeps not_started status when tracking is null', () => {
    const merged = mergeWithTracking(baseFeature, null)
    assert.equal(merged.status, 'not_started')
  })
})
