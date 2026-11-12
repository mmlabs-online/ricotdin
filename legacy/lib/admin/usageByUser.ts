// Pure helpers for per-user AI usage aggregation on the admin user list.
// No I/O — fully unit-testable.
//
// Two providers meter in incommensurable units (see migration 009):
//   * Gemini text + embeddings → tokens        (unit = 'tokens')
//   * Speechmatics STT         → audio_seconds  (unit = 'audio_seconds')
// We surface, per user, the total Gemini tokens and the total Speechmatics
// audio-seconds ("script duration"). NEVER add the two together.

export type UsageLogRow = {
  user_id: string | null
  unit: string
  total_tokens: number | null
  audio_seconds: number | null
}

export type UserUsage = {
  geminiTokens: number   // sum of total_tokens for unit='tokens' rows
  audioSeconds: number   // sum of audio_seconds for unit='audio_seconds' rows
}

export type MonthRange = {
  month: string      // normalized 'YYYY-MM'
  startISO: string   // inclusive lower bound (first instant of the month, UTC)
  endISO: string     // exclusive upper bound (first instant of the next month, UTC)
}

// Parse a 'YYYY-MM' string into a UTC [start, end) range covering that calendar
// month. Falls back to the current month when the input is missing or invalid.
export function monthRange(month: string | null | undefined, now: Date = new Date()): MonthRange {
  const m = /^(\d{4})-(\d{2})$/.exec((month ?? '').trim())
  let year = now.getUTCFullYear()
  let mon = now.getUTCMonth() + 1 // 1-12

  if (m) {
    const y = parseInt(m[1], 10)
    const mo = parseInt(m[2], 10)
    if (mo >= 1 && mo <= 12) {
      year = y
      mon = mo
    }
  }

  const start = new Date(Date.UTC(year, mon - 1, 1))
  const end = new Date(Date.UTC(year, mon, 1)) // Date.UTC rolls Dec → next Jan

  return {
    month: `${year}-${String(mon).padStart(2, '0')}`,
    startISO: start.toISOString(),
    endISO: end.toISOString(),
  }
}

// Aggregate raw usage_log rows into a per-user { geminiTokens, audioSeconds } map.
// Rows with a null user_id are ignored (cannot be attributed).
export function aggregateUsageByUser(rows: UsageLogRow[]): Map<string, UserUsage> {
  const map = new Map<string, UserUsage>()
  for (const row of rows) {
    if (!row.user_id) continue
    const cur = map.get(row.user_id) ?? { geminiTokens: 0, audioSeconds: 0 }
    if (row.unit === 'tokens') {
      cur.geminiTokens += row.total_tokens ?? 0
    } else if (row.unit === 'audio_seconds') {
      cur.audioSeconds += row.audio_seconds ?? 0
    }
    map.set(row.user_id, cur)
  }
  return map
}
