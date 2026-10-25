// Pure parsing helpers for the feature registry seeder.
// No filesystem or DB access — all functions take strings and return plain
// objects so they can be exercised in unit tests without I/O.

// ── Types ─────────────────────────────────────────────────────────────────────

export type FeatureStatus = 'done' | 'partial' | 'not_started'

export interface ParsedFeature {
  key: string
  title: string
  user_story: string | null
  status: FeatureStatus
  content: string
  module_prefix: string
  module_name: string
  key_files: string[]
  source_path: string
  metadata: Record<string, unknown>
}

export interface TrackingRow {
  feature_code: string
  description: string
  user_story_fallback: string
  is_done: boolean
  depends_on: string[]
  note_tags: string[]
  priority: 'high' | 'medium' | 'low' | null
}

export interface MergedFeature extends ParsedFeature {
  description: string | null
  depends_on: string[]
  note_tags: string[]
  priority: 'high' | 'medium' | 'low' | null
}

// ── Status normalisation ──────────────────────────────────────────────────────

export function parseStatus(raw: string): FeatureStatus {
  if (raw.includes('✅') || raw.includes('[x]')) return 'done'
  if (raw.includes('⚠️') || /partial/i.test(raw)) return 'partial'
  return 'not_started'
}

// ── Feature section parser ────────────────────────────────────────────────────
// Accepts the raw text of a single ### section (WITHOUT the ### header line)
// and returns the structured fields extracted from it.

export function parseFeatureSection(
  key: string,
  title: string,
  sectionBody: string,
): Pick<ParsedFeature, 'key' | 'title' | 'user_story' | 'status' | 'content'> {
  const statusRaw = sectionBody.match(/\*\*Status:\*\*\s*(.+)/m)?.[1] ?? ''
  const status = parseStatus(statusRaw)

  // User story: text on the line(s) immediately after **User Story** until the
  // next blank line or the next bold heading.
  const userStoryMatch = sectionBody.match(
    /\*\*User Story\*\*\s*\n+([^\n].+?)(?=\n\n|\n\*\*)/ms,
  )
  const user_story = userStoryMatch
    ? userStoryMatch[1].trim().replace(/\s+/g, ' ')
    : null

  return {
    key,
    title,
    user_story,
    status,
    content: sectionBody.trim(),
  }
}

// ── Module file parser ────────────────────────────────────────────────────────
// Accepts the raw markdown string of a module file (e.g. feature-Recording-REC.md)
// and returns one ParsedFeature per ### section found.

export function parseModuleFile(
  rawMarkdown: string,
  sourcePath: string,
): ParsedFeature[] {
  // Module name + prefix from H1: "# Recording Module (REC)" or "# Admin (ADM)"
  const moduleMatch = rawMarkdown.match(/^#\s+(.+?)\s*\((\w+)\)\s*$/m)
  const moduleName = (moduleMatch?.[1] ?? 'Unknown')
    .replace(/\s+Module\s*$/, '')
    .trim()
  const modulePrefix = moduleMatch?.[2] ?? 'UNK'

  // Key files list from the header area
  const keyFilesRaw =
    rawMarkdown.match(/\*\*Key files:\*\*\s*(.+)/m)?.[1] ?? ''
  const keyFiles = keyFilesRaw
    .split(',')
    .map((f) => f.trim().replace(/`/g, '').trim())
    .filter(Boolean)

  // Module-level sections → metadata
  const overviewRaw =
    rawMarkdown.match(/## Overview\s*([\s\S]*?)(?=\n## |\n---\n)/m)?.[1]?.trim() ?? ''
  const dataFlowRaw =
    rawMarkdown.match(/## Data Flow\s*([\s\S]*?)(?=\n## |$)/m)?.[1]?.trim() ?? ''
  const depsSection =
    rawMarkdown.match(/## Dependencies\s*([\s\S]*?)(?=\n## |$)/m)?.[1] ?? ''

  const metadata: Record<string, unknown> = {}
  if (overviewRaw) metadata.module_overview = overviewRaw
  if (dataFlowRaw) metadata.module_data_flow = dataFlowRaw

  const moduleDependsOn = depsSection.match(/\*\*Depends on:\*\*\s*(.+)/)?.[1]?.trim()
  const moduleBlocks = depsSection.match(/\*\*Blocks:\*\*\s*(.+)/)?.[1]?.trim()
  if (moduleDependsOn) metadata.module_depends_on = moduleDependsOn
  if (moduleBlocks) metadata.module_blocks = moduleBlocks

  // Isolate the ## Features section (stop before ## Data Flow / ## Dependencies)
  const featuresSectionRaw = rawMarkdown.match(
    /## Features\s*([\s\S]*?)(?=\n## Data Flow|\n## Dependencies|$)/,
  )?.[1] ?? rawMarkdown

  // Split into individual feature blocks by ### PREFIX-NN heading
  // The split keeps each block starting with the ### header line.
  const blocks = featuresSectionRaw
    .split(/(?=^### [A-Z]+-\d)/m)
    .filter((b) => b.trim())

  const features: ParsedFeature[] = []

  for (const block of blocks) {
    // Match "### REC-01 — Title" (em dash, en dash, or plain hyphen)
    const headerMatch = block.match(/^### ([A-Z]+-\d+\w*)\s+[—–-]\s+(.+?)$/m)
    if (!headerMatch) continue

    const key = headerMatch[1].trim()
    const title = headerMatch[2].trim()
    // Body is the block with the ### header line removed
    const sectionBody = block.replace(/^### .+$/m, '')

    const parsed = parseFeatureSection(key, title, sectionBody)

    features.push({
      ...parsed,
      module_prefix: modulePrefix,
      module_name: moduleName,
      key_files: keyFiles,
      source_path: sourcePath,
      metadata,
    })
  }

  return features
}

// ── Tracking.md table parser ──────────────────────────────────────────────────
// Accepts the raw markdown string of tracking.md and returns a Map keyed by
// feature code (e.g. 'REC-01').

export function parseTrackingMd(rawMarkdown: string): Map<string, TrackingRow> {
  const result = new Map<string, TrackingRow>()

  for (const line of rawMarkdown.split('\n')) {
    if (!line.startsWith('|')) continue
    // Skip separator rows like |---|---|...|
    if (/^\|[-\s|]+\|$/.test(line.trim())) continue

    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim())

    // Columns: Module | Feature | Feature Code | Subfeature | Description | Is Done? | Constraint | Note
    if (cells.length < 8) continue
    const featureCode = cells[2]
    if (!featureCode.match(/^[A-Z]+-\d+/)) continue

    const user_story_fallback = cells[3]
    const description = cells[4]
    const isDone = cells[5].includes('[x]')
    const constraintRaw = cells[6]
    const noteRaw = cells[7]

    const depends_on =
      constraintRaw === '—' || constraintRaw === '-' || constraintRaw === ''
        ? []
        : constraintRaw
            .split(',')
            .map((s) => s.trim())
            .filter((s) => /^[A-Z]+-\d+/.test(s))

    const note_tags: string[] = []
    if (/blocker/i.test(noteRaw)) note_tags.push('Blocker')
    if (/mandatory/i.test(noteRaw)) note_tags.push('Mandatory')
    if (/saas/i.test(noteRaw)) note_tags.push('SaaS')

    let priority: 'high' | 'medium' | 'low' | null = null
    if (/priority:\s*high/i.test(noteRaw)) priority = 'high'
    else if (/priority:\s*medium/i.test(noteRaw)) priority = 'medium'
    else if (/priority:\s*low/i.test(noteRaw)) priority = 'low'

    result.set(featureCode, {
      feature_code: featureCode,
      description,
      user_story_fallback,
      is_done: isDone,
      depends_on,
      note_tags,
      priority,
    })
  }

  return result
}

// ── Merge ─────────────────────────────────────────────────────────────────────
// Combines a ParsedFeature (from the module file) with its TrackingRow
// (from tracking.md). tracking.md is authoritative for is_done and description.

export function mergeWithTracking(
  feature: ParsedFeature,
  tracking: TrackingRow | null | undefined,
): MergedFeature {
  // Status: if tracking says done, trust it (tracking.md is kept up-to-date).
  // If tracking says not done but file says partial, keep partial.
  let status: FeatureStatus = feature.status
  if (tracking?.is_done) {
    status = 'done'
  }

  return {
    ...feature,
    status,
    description: tracking?.description ?? null,
    user_story: feature.user_story ?? tracking?.user_story_fallback ?? null,
    depends_on: tracking?.depends_on ?? [],
    note_tags: tracking?.note_tags ?? [],
    priority: tracking?.priority ?? null,
  }
}
