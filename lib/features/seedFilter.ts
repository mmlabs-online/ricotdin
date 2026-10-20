// Pure helpers for the feature seeder's `--only` flag.
// `--only PRO-09,REC-12` limits the upsert to those keys so adding a new
// feature never overwrites edits made to other features at /admin/features.

const FEATURE_KEY = /^[A-Z]+-\d+\w*$/

export class SeedArgsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SeedArgsError'
  }
}

// Returns the requested keys, or null when --only is absent (seed everything).
export function parseOnlyKeys(argv: string[]): string[] | null {
  let raw: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--only') {
      const next = argv[i + 1]
      raw = next && !next.startsWith('--') ? next : ''
      break
    }
    if (arg.startsWith('--only=')) {
      raw = arg.slice('--only='.length)
      break
    }
  }

  if (raw === undefined) return null

  const keys = [
    ...new Set(
      raw
        .split(',')
        .map((k) => k.trim().toUpperCase())
        .filter(Boolean),
    ),
  ]

  if (keys.length === 0) {
    throw new SeedArgsError('--only requires at least one feature code, e.g. --only PRO-09')
  }

  const invalid = keys.filter((k) => !FEATURE_KEY.test(k))
  if (invalid.length > 0) {
    throw new SeedArgsError(`Invalid feature code(s): ${invalid.join(', ')}`)
  }

  return keys
}

export function selectFeatures<T extends { key: string }>(
  features: T[],
  onlyKeys: string[] | null,
): { selected: T[]; missing: string[] } {
  if (onlyKeys === null) return { selected: features, missing: [] }

  const wanted = new Set(onlyKeys)
  const selected = features.filter((f) => wanted.has(f.key))
  const found = new Set(selected.map((f) => f.key))
  const missing = onlyKeys.filter((k) => !found.has(k))

  return { selected, missing }
}
