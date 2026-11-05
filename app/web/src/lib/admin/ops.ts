// Admin operations screens (ARC-14b: pipeline, usage, activity, audit). Pure.
// The API decides every rule (§0.9); these only shape what it returns and hide refused controls.

export const PIPELINE_FILTERS = ['all', 'pending', 'processing', 'stuck', 'failed', 'done'] as const
export type PipelineFilter = (typeof PIPELINE_FILTERS)[number]

export function pipelineFilter(raw: string | null): PipelineFilter {
  return (PIPELINE_FILTERS as readonly string[]).includes(raw ?? '') && raw ? (raw as PipelineFilter) : 'all'
}

export interface PipelineJob {
  status: string
  is_stuck: boolean
  job: { status: string; step: string | null; attempts: number; last_error: string | null } | null
}

/** Requeue = failed or stuck meetings with no queued/running job (else the API answers 422/409). */
export function canRequeue(j: PipelineJob): boolean {
  const active = j.job?.status === 'queued' || j.job?.status === 'running'
  return !active && (j.status === 'failed' || (j.status === 'processing' && j.is_stuck))
}

export function durationParts(seconds: number | null | undefined): { h: number; m: number; s: number } | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null
  const t = Math.round(seconds)
  return { h: Math.floor(t / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 }
}

// --- dates ---------------------------------------------------------------------------------------

const DAY = 86_400_000
export const MAX_RANGE_DAYS = 400 // app/domain/admin_ops.py MAX_USAGE_RANGE_DAYS

const iso = (d: Date) => d.toISOString().slice(0, 10)

/** A `YYYY-MM-DD` that is a real date in 1970–2100 (the API ignores others), else null. */
export function dateInput(v: string | null | undefined): string | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
  const d = new Date(`${v}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || iso(d) !== v) return null
  const y = d.getUTCFullYear()
  return y >= 1970 && y <= 2100 ? v : null
}

export function defaultRange(now: Date): { from: string; to: string } {
  return { from: iso(new Date(now.getTime() - 30 * DAY)), to: iso(now) }
}

/** `to` is a whole day (the API adds it), so the span is to − from + 1 day. */
export function rangeProblem(from: string, to: string): string | null {
  const f = dateInput(from)
  const t = dateInput(to)
  if (!f || !t) return 'admin.usage.errors.date'
  if (f > t) return 'admin.usage.errors.order'
  const days = (Date.parse(t) - Date.parse(f)) / DAY + 1
  return days > MAX_RANGE_DAYS ? 'admin.usage.errors.tooLong' : null
}

// --- AI usage ------------------------------------------------------------------------------------

export interface UsageRow {
  provider: string
  model: string
  operation: string | null
  unit: string
  key_id: string | null
  key_label: string | null
  key_last4: string | null
  calls: number
  total_tokens: number | null
  total_input_tokens: number | null
  total_output_tokens: number | null
  total_audio_seconds: number | null
  rate_limited_count: number
  error_count: number
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** KPI totals. Tokens and audio seconds are never added together (CLAUDE.md §9e). */
export function usageSummary(rows: readonly unknown[]) {
  const s = { tokenCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, audioCalls: 0, audioSeconds: 0, rateLimited: 0, errors: 0, calls: 0 }
  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Partial<UsageRow>
    if (r.unit === 'tokens') {
      s.tokenCalls += n(r.calls)
      s.inputTokens += n(r.total_input_tokens)
      s.outputTokens += n(r.total_output_tokens)
      s.totalTokens += n(r.total_tokens)
    } else if (r.unit === 'audio_seconds') {
      s.audioCalls += n(r.calls)
      s.audioSeconds += n(r.total_audio_seconds)
    } else continue
    s.rateLimited += n(r.rate_limited_count)
    s.errors += n(r.error_count)
  }
  s.calls = s.tokenCalls + s.audioCalls
  return s
}

/** Fixed colour slots: a provider keeps its colour whatever else is on screen. */
export const PROVIDER_ORDER = ['gemini', 'openai', 'grok', 'speechmatics', 'gemini-embedding'] as const

const rank = (p: string) => {
  const i = (PROVIDER_ORDER as readonly string[]).indexOf(p)
  return i === -1 ? PROVIDER_ORDER.length : i
}
const byProvider = (a: string, b: string) => rank(a) - rank(b) || a.localeCompare(b)

export interface DailyTotal {
  date: string
  provider: string
  unit: string
  quantity: number
}

/** One stacked bar per day for one unit (tokens and audio are separate charts). */
export function dailyBars(rows: readonly DailyTotal[], unit: 'tokens' | 'audio_seconds') {
  const days = new Map<string, Map<string, number>>()
  const providers = new Set<string>()
  for (const r of rows) {
    if (r.unit !== unit || !dateInput(r.date) || typeof r.provider !== 'string' || !Number.isFinite(r.quantity) || r.quantity < 0) continue
    providers.add(r.provider)
    const day = days.get(r.date) ?? new Map<string, number>()
    day.set(r.provider, (day.get(r.provider) ?? 0) + r.quantity)
    days.set(r.date, day)
  }
  const list = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, parts]) => {
      const sorted = [...parts.entries()].sort(([a], [b]) => byProvider(a, b)).map(([provider, quantity]) => ({ provider, quantity }))
      return { date, total: sorted.reduce((t, p) => t + p.quantity, 0), parts: sorted }
    })
  return { days: list, providers: [...providers].sort(byProvider), max: Math.max(0, ...list.map((d) => d.total)) }
}

/** Colour slot (1-based) for a provider: the fixed order, unknown ones share the last slot. */
export function providerSlot(provider: string): number {
  return Math.min(rank(provider), PROVIDER_ORDER.length) + 1
}

// --- activity + audit ----------------------------------------------------------------------------

const EVENTS = new Set([
  'login', 'logout', 'record_start', 'record_stop', 'recording_notice_ack', 'meeting_created',
  'meeting_deleted', 'processing_done', 'processing_failed', 'chat_message', 'meeting_shared', 'meeting_unshared',
])
export const EVENT_TYPES = [...EVENTS]

export function eventKey(type: string): string {
  return `admin.events.${EVENTS.has(type) ? type : 'other'}`
}

/** Activity / audit metadata shown as text (users write their own activity rows, §0.9). */
export function metadataText(meta: unknown, max = 500): string | null {
  if (meta === null || meta === undefined) return null
  if (typeof meta === 'object' && Object.keys(meta).length === 0) return null
  let s: string
  try {
    s = JSON.stringify(meta)
  } catch {
    return null
  }
  return s.length > max ? s.slice(0, max) : s
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function uuidOrNull(v: string | null | undefined): string | null {
  return v && UUID.test(v) ? v.toLowerCase() : null
}
