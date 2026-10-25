// Pure helpers for app-config validation and parsing.
// No I/O — fully unit-testable in isolation.

export type ConfigValue = boolean | number | string | null

export function isValidConfigValue(value: unknown): value is ConfigValue {
  if (value === null) return true
  const t = typeof value
  return t === 'boolean' || t === 'number' || t === 'string'
}

export function configValueType(v: ConfigValue): 'boolean' | 'number' | 'string' | 'null' {
  if (v === null)            return 'null'
  if (typeof v === 'boolean') return 'boolean'
  if (typeof v === 'number')  return 'number'
  return 'string'
}

export function parseConfigInput(
  input: string,
  type: 'boolean' | 'number' | 'string' | 'null',
): ConfigValue {
  switch (type) {
    case 'boolean': return input === 'true'
    case 'number':  return parseFloat(input)
    case 'string':  return input
    case 'null':    return null
  }
}

/**
 * Read an `app_config` jsonb value as a boolean.
 *
 * The value column is jsonb, so a flag can arrive as a real boolean, as the
 * string form the config editor produces, or as 1/0. Anything unrecognised
 * (including a missing row) yields `fallback` — a malformed flag must never
 * silently flip a feature on.
 */
export function coerceConfigBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
    return fallback
  }
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true')  return true
    if (v === 'false') return false
    return fallback
  }
  return fallback
}
