// GET /api/admin/ai-usage?from=&to=&groupBy=operation
//
// Returns aggregated AI provider usage over a date range.
// Groups by provider + model (always) and optionally by operation.
//
// Query params:
//   from    — ISO 8601 start (inclusive); defaults to 30 days ago
//   to      — ISO 8601 end   (inclusive); defaults to now
//   groupBy — 'operation' to further split by operation; omit for provider+model only
//
// Response shape (per group, unit-separated so tokens and audio_seconds are NEVER mixed):
//   { rows: AiUsageRow[], dailyTotals: DailyTotal[] }
//
// AiUsageRow:
//   provider, model, operation (if groupBy=operation), unit,
//   calls, total_tokens (tokens rows), total_input_tokens, total_output_tokens,
//   total_audio_seconds (audio_seconds rows),
//   rate_limited_count, error_count
//
// SECURITY: requires admin role (server-enforced).

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/server'
import { logger } from '@/lib/logger'

// ── Types ─────────────────────────────────────────────────────────────────────

export type AiUsageRow = {
  provider: string
  model: string
  operation: string | null   // null when groupBy != 'operation'
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

export type DailyTotal = {
  date: string    // YYYY-MM-DD
  provider: string
  unit: string
  quantity: number
}

// ── Helper ────────────────────────────────────────────────────────────────────

function parseDate(raw: string | null, fallback: Date): Date {
  if (!raw) return fallback
  const d = new Date(raw)
  return isNaN(d.getTime()) ? fallback : d
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  const { searchParams } = req.nextUrl
  const groupByOperation = searchParams.get('groupBy') === 'operation'
  const userId = searchParams.get('userId') ?? null

  const now = new Date()
  const defaultFrom = new Date(now)
  defaultFrom.setDate(defaultFrom.getDate() - 30)

  const fromDate = parseDate(searchParams.get('from'), defaultFrom)
  const toDate   = parseDate(searchParams.get('to'), now)

  // Clamp: from must be before to
  if (fromDate >= toDate) {
    return NextResponse.json(
      { error: '"from" must be earlier than "to".' },
      { status: 400 },
    )
  }

  const db = createServerClient()

  // ── Aggregate query ────────────────────────────────────────────────────────
  // Supabase JS doesn't support arbitrary GROUP BY, so we use a raw RPC or
  // PostgREST aggregation. We fetch filtered rows and aggregate in JS —
  // usage_log is expected to have tens of thousands of rows (not millions),
  // so fetching all rows in range is safe. If the table grows large we can
  // add a dedicated Postgres aggregate RPC via migration.
  let usageQuery = db
    .from('usage_log')
    .select(
      'provider, model, operation, unit, quantity, input_tokens, output_tokens, total_tokens, audio_seconds, status, key_id',
    )
    .gte('created_at', fromDate.toISOString())
    .lte('created_at', toDate.toISOString())
    .order('created_at', { ascending: true })

  if (userId) usageQuery = usageQuery.eq('user_id', userId)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rows, error } = await (usageQuery as any) as {
    data: Array<{
      provider: string; model: string; operation: string | null; unit: string;
      quantity: number; input_tokens: number | null; output_tokens: number | null;
      total_tokens: number | null; audio_seconds: number | null;
      status: string; key_id: string | null;
    }> | null;
    error: { message: string } | null;
  }

  if (error) {
    logger.error('[admin/ai-usage] query failed', { detail: error.message })
    return NextResponse.json({ error: 'Failed to fetch usage data.' }, { status: 500 })
  }

  // ── In-process aggregation ────────────────────────────────────────────────
  type AggKey = string
  const groups = new Map<AggKey, AiUsageRow>()

  for (const row of rows ?? []) {
    const aggKey = groupByOperation
      ? `${row.provider}|${row.model}|${row.operation}|${row.unit}|${row.key_id ?? ''}`
      : `${row.provider}|${row.model}|${row.unit}|${row.key_id ?? ''}`

    const existing = groups.get(aggKey)
    if (!existing) {
      groups.set(aggKey, {
        provider: row.provider,
        model: row.model,
        operation: groupByOperation ? row.operation : null,
        unit: row.unit,
        key_id:    row.key_id ?? null,
        key_label: null,  // enriched after aggregation
        key_last4: null,
        calls: 1,
        total_tokens:       row.unit === 'tokens'        ? (row.total_tokens ?? 0)   : null,
        total_input_tokens: row.unit === 'tokens'        ? (row.input_tokens ?? 0)   : null,
        total_output_tokens:row.unit === 'tokens'        ? (row.output_tokens ?? 0)  : null,
        total_audio_seconds:row.unit === 'audio_seconds' ? (row.audio_seconds ?? 0)  : null,
        rate_limited_count: row.status === 'rate_limited' ? 1 : 0,
        error_count:        row.status === 'error'        ? 1 : 0,
      })
    } else {
      existing.calls++
      if (row.unit === 'tokens') {
        existing.total_tokens        = (existing.total_tokens        ?? 0) + (row.total_tokens  ?? 0)
        existing.total_input_tokens  = (existing.total_input_tokens  ?? 0) + (row.input_tokens  ?? 0)
        existing.total_output_tokens = (existing.total_output_tokens ?? 0) + (row.output_tokens ?? 0)
      } else if (row.unit === 'audio_seconds') {
        existing.total_audio_seconds = (existing.total_audio_seconds ?? 0) + (row.audio_seconds ?? 0)
      }
      if (row.status === 'rate_limited') existing.rate_limited_count++
      if (row.status === 'error')        existing.error_count++
    }
  }

  // ── Enrich with key label / last4 ─────────────────────────────────────────
  const keyIds = [...new Set([...groups.values()].map(r => r.key_id).filter(Boolean))] as string[]
  if (keyIds.length > 0) {
    const { data: keyRows } = await db
      .from('admin_config')
      .select('id, label, last4')
      .in('id', keyIds)
    const keyMeta = new Map<string, { label: string | null; last4: string | null }>()
    for (const k of keyRows ?? []) {
      keyMeta.set(k.id as string, { label: k.label as string | null, last4: k.last4 as string | null })
    }
    for (const row of groups.values()) {
      if (row.key_id) {
        const m = keyMeta.get(row.key_id)
        if (m) { row.key_label = m.label; row.key_last4 = m.last4 }
      }
    }
  }

  // ── Daily totals for trend chart (quantity per provider per day) ──────────
  let dailyQuery = db
    .from('usage_log')
    .select('created_at, provider, unit, quantity')
    .gte('created_at', fromDate.toISOString())
    .lte('created_at', toDate.toISOString())
    .order('created_at', { ascending: true })

  if (userId) dailyQuery = dailyQuery.eq('user_id', userId)

  const { data: dailyRows, error: dailyErr } = await dailyQuery

  if (dailyErr) {
    logger.warn('[admin/ai-usage] daily totals query failed', { detail: dailyErr.message })
  }

  type DailyKey = string
  const dailyGroups = new Map<DailyKey, DailyTotal>()

  for (const row of dailyRows ?? []) {
    const date = row.created_at.slice(0, 10)  // YYYY-MM-DD
    const key  = `${date}|${row.provider}|${row.unit}`
    const existing = dailyGroups.get(key)
    if (!existing) {
      dailyGroups.set(key, { date, provider: row.provider, unit: row.unit, quantity: row.quantity ?? 0 })
    } else {
      existing.quantity += row.quantity ?? 0
    }
  }

  return NextResponse.json({
    from: fromDate.toISOString(),
    to:   toDate.toISOString(),
    rows:        [...groups.values()].sort((a, b) =>
      `${a.provider}${a.model}${a.operation ?? ''}`.localeCompare(
        `${b.provider}${b.model}${b.operation ?? ''}`,
      ),
    ),
    dailyTotals: [...dailyGroups.values()],
  })
}
