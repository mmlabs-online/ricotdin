'use client'

import type { CSSProperties } from 'react'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { getAccessToken, getCurrentRole } from '@/lib/supabase/auth'
import { formatBytes } from '@/lib/admin/usage'
import type { AiUsageRow, DailyTotal } from '@/app/api/admin/ai-usage/route'

// ── Types ─────────────────────────────────────────────────────────────────────

type MeetingStats = {
  total: number
  byStatus: Record<string, number>
  failureRate: number
  last7Days: number
  last30Days: number
}

type StorageStats = {
  totalBytes: number
  fileCount: number
}

type AiUsageData = {
  from: string
  to: string
  rows: AiUsageRow[]
  dailyTotals: DailyTotal[]
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function toDateInput(iso: string) {
  return iso.slice(0, 10)
}

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtTokens(n: number | null) {
  if (n === null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtMinutes(secs: number | null) {
  if (secs === null) return '—'
  const m = secs / 60
  return m >= 1 ? `${m.toFixed(1)} min` : `${secs.toFixed(0)} s`
}

// ── Micro trend chart (SVG) ───────────────────────────────────────────────────
// One bar per calendar day; one stacked segment per provider.
// Tokens and audio_seconds are rendered separately (never stacked together).

const PROVIDER_COLORS: Record<string, string> = {
  'gemini':           '#4f8ef7',
  'gemini-embedding': '#a78bfa',
  'speechmatics':     '#34d399',
}

function providerColor(p: string): string {
  return PROVIDER_COLORS[p] ?? '#94a3b8'
}

type ChartProps = {
  dailyTotals: DailyTotal[]
  unit: 'tokens' | 'audio_seconds'
  from: string
  to: string
}

function TrendChart({ dailyTotals, unit, from, to }: ChartProps) {
  const filtered = dailyTotals.filter(d => d.unit === unit)
  if (filtered.length === 0) return <p style={S.muted}>No data in range.</p>

  // Build ordered date list
  const start = new Date(from + 'T00:00:00Z')
  const end   = new Date(to   + 'T23:59:59Z')
  const dates: string[] = []
  const cur = new Date(start)
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10))
    cur.setUTCDate(cur.getUTCDate() + 1)
  }

  // Providers present in the data
  const providers = [...new Set(filtered.map(d => d.provider))].sort()

  // quantity per date per provider
  const byDateProvider: Record<string, Record<string, number>> = {}
  for (const d of filtered) {
    if (!byDateProvider[d.date]) byDateProvider[d.date] = {}
    byDateProvider[d.date][d.provider] = (byDateProvider[d.date][d.provider] ?? 0) + d.quantity
  }

  // max stacked quantity across all dates
  const maxVal = Math.max(
    ...dates.map(dt =>
      providers.reduce((sum, p) => sum + (byDateProvider[dt]?.[p] ?? 0), 0),
    ),
    1,
  )

  const W = 640
  const H = 120
  const PAD_L = 8
  const PAD_R = 8
  const PAD_T = 8
  const PAD_B = 20
  const chartW = W - PAD_L - PAD_R
  const chartH = H - PAD_T - PAD_B
  const barW   = Math.max(2, Math.floor(chartW / dates.length) - 1)

  const bars: React.ReactNode[] = []
  dates.forEach((dt, i) => {
    const x = PAD_L + i * (chartW / dates.length)
    let yBase = PAD_T + chartH
    for (const p of providers) {
      const val = byDateProvider[dt]?.[p] ?? 0
      if (val === 0) continue
      const barH = Math.max(1, Math.round((val / maxVal) * chartH))
      yBase -= barH
      bars.push(
        <rect
          key={`${dt}-${p}`}
          x={x} y={yBase} width={barW} height={barH}
          fill={providerColor(p)}
          opacity={0.85}
        >
          <title>{`${dt} · ${p}: ${unit === 'tokens' ? fmtTokens(val) : fmtMinutes(val)}`}</title>
        </rect>,
      )
    }
    // x-axis label every 7 days
    if (i % 7 === 0) {
      bars.push(
        <text key={`lbl-${dt}`} x={x} y={H - 4} fontSize={9} fill="#94a3b8">
          {dt.slice(5)}
        </text>,
      )
    }
  })

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: W, display: 'block' }}>
        {/* baseline */}
        <line
          x1={PAD_L} y1={PAD_T + chartH}
          x2={W - PAD_R} y2={PAD_T + chartH}
          stroke="#e2e8f0" strokeWidth={1}
        />
        {bars}
      </svg>
      {/* Legend */}
      <div style={{ display: 'flex', gap: 14, marginTop: 6, flexWrap: 'wrap' }}>
        {providers.map(p => (
          <span key={p} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#475569' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: providerColor(p), flexShrink: 0 }} />
            {p}
          </span>
        ))}
      </div>
    </div>
  )
}

// ── AI Usage table ────────────────────────────────────────────────────────────

function AiUsageTable({ rows }: { rows: AiUsageRow[] }) {
  if (rows.length === 0) {
    return <p style={S.muted}>No usage recorded for this date range.</p>
  }

  // Group by unit so tokens and audio_seconds are never in the same table
  const tokenRows   = rows.filter(r => r.unit === 'tokens')
  const audioRows   = rows.filter(r => r.unit === 'audio_seconds')

  return (
    <>
      {tokenRows.length > 0 && (
        <>
          <h3 style={S.h3}>Token-metered (Gemini)</h3>
          <div style={S.tableWrap}>
            <table style={S.table}>
              <thead>
                <tr>
                  <Th>Provider</Th>
                  <Th>Model</Th>
                  <Th>Operation</Th>
                  <Th>Key</Th>
                  <Th right>Calls</Th>
                  <Th right>Input tokens</Th>
                  <Th right>Output tokens</Th>
                  <Th right>Total tokens</Th>
                  <Th right>429s</Th>
                  <Th right>Errors</Th>
                </tr>
              </thead>
              <tbody>
                {tokenRows.map((r, i) => (
                  <tr key={i} style={i % 2 === 1 ? S.rowAlt : undefined}>
                    <Td><ProviderBadge p={r.provider} /></Td>
                    <Td><code style={S.code}>{r.model}</code></Td>
                    <Td>{r.operation ?? '—'}</Td>
                    <Td><KeyCell label={r.key_label} last4={r.key_last4} /></Td>
                    <Td right>{r.calls.toLocaleString()}</Td>
                    <Td right>{fmtTokens(r.total_input_tokens)}</Td>
                    <Td right>{fmtTokens(r.total_output_tokens)}</Td>
                    <Td right><strong>{fmtTokens(r.total_tokens)}</strong></Td>
                    <Td right>{r.rate_limited_count > 0
                      ? <span style={S.warn}>{r.rate_limited_count}</span>
                      : '0'}
                    </Td>
                    <Td right>{r.error_count > 0
                      ? <span style={S.err}>{r.error_count}</span>
                      : '0'}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {audioRows.length > 0 && (
        <>
          <h3 style={{ ...S.h3, marginTop: tokenRows.length > 0 ? 20 : 0 }}>Audio-metered (Speechmatics)</h3>
          <div style={S.tableWrap}>
            <table style={S.table}>
              <thead>
                <tr>
                  <Th>Provider</Th>
                  <Th>Model</Th>
                  <Th>Operation</Th>
                  <Th>Key</Th>
                  <Th right>Calls</Th>
                  <Th right>Total audio</Th>
                  <Th right>429s</Th>
                  <Th right>Errors</Th>
                </tr>
              </thead>
              <tbody>
                {audioRows.map((r, i) => (
                  <tr key={i} style={i % 2 === 1 ? S.rowAlt : undefined}>
                    <Td><ProviderBadge p={r.provider} /></Td>
                    <Td><code style={S.code}>{r.model}</code></Td>
                    <Td>{r.operation ?? '—'}</Td>
                    <Td><KeyCell label={r.key_label} last4={r.key_last4} /></Td>
                    <Td right>{r.calls.toLocaleString()}</Td>
                    <Td right><strong>{fmtMinutes(r.total_audio_seconds)}</strong></Td>
                    <Td right>{r.rate_limited_count > 0
                      ? <span style={S.warn}>{r.rate_limited_count}</span>
                      : '0'}
                    </Td>
                    <Td right>{r.error_count > 0
                      ? <span style={S.err}>{r.error_count}</span>
                      : '0'}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  )
}

function ProviderBadge({ p }: { p: string }) {
  return (
    <span style={{ ...S.badge, background: `${providerColor(p)}22`, color: providerColor(p) }}>
      {p}
    </span>
  )
}

function KeyCell({ label, last4 }: { label: string | null; last4: string | null }) {
  if (!label && !last4) {
    return <span style={{ color: '#94a3b8', fontSize: 11 }}>env</span>
  }
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      {label && <span style={{ fontSize: 12, color: '#334155' }}>{label}</span>}
      {last4 && <code style={{ ...S.code, fontSize: 11 }}>••••{last4}</code>}
    </span>
  )
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th style={{ ...S.th, ...(right ? { textAlign: 'right' } : {}) }}>{children}</th>
}
function Td({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <td style={{ ...S.td, ...(right ? { textAlign: 'right' } : {}) }}>{children}</td>
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function UsagePage() {
  const router = useRouter()

  // Auth / global state
  const [loading, setLoading]         = useState(true)
  const [forbidden, setForbidden]     = useState(false)
  const [error, setError]             = useState<string | null>(null)
  const [success, setSuccess]         = useState<string | null>(null)

  // Meeting + storage stats (existing)
  const [meetings, setMeetings]       = useState<MeetingStats | null>(null)
  const [storage, setStorage]         = useState<StorageStats | null>(null)
  const [orphans, setOrphans]         = useState<string[] | null>(null)
  const [orphansLoading, setOL]       = useState(false)
  const [cleanupBusy, setCleanupBusy] = useState(false)

  // AI usage
  const [aiData, setAiData]           = useState<AiUsageData | null>(null)
  const [aiLoading, setAiLoading]     = useState(false)
  const [groupByOp, setGroupByOp]     = useState(true)
  const [fromDate, setFromDate]       = useState(daysAgo(30))
  const [toDate, setToDate]           = useState(todayIso)

  const fetchAiUsage = useCallback(async (from: string, to: string, byOp: boolean) => {
    setAiLoading(true)
    const token = await getAccessToken()
    if (!token) return
    const params = new URLSearchParams({
      from: `${from}T00:00:00Z`,
      to:   `${to}T23:59:59Z`,
      ...(byOp ? { groupBy: 'operation' } : {}),
    })
    const res = await fetch(`/api/admin/ai-usage?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = (await res.json()) as AiUsageData & { error?: string }
    if (!res.ok) { setError(data.error ?? 'Failed to load AI usage.'); setAiLoading(false); return }
    setAiData(data)
    setAiLoading(false)
  }, [])

  useEffect(() => {
    async function init() {
      const role = await getCurrentRole()
      if (role !== 'admin') { setForbidden(true); setLoading(false); return }

      const token = await getAccessToken()
      if (!token) { router.replace('/login'); return }

      // Load meeting + storage stats
      const res = await fetch('/api/admin/usage', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.status === 403) { setForbidden(true); setLoading(false); return }
      const data = (await res.json()) as { meetings?: MeetingStats; storage?: StorageStats; error?: string }
      if (!res.ok) { setError(data.error ?? 'Failed to load usage.'); setLoading(false); return }
      setMeetings(data.meetings ?? null)
      setStorage(data.storage ?? null)
      setLoading(false)

      // Load AI usage (default: last 30 days, grouped by operation)
      void fetchAiUsage(fromDate, toDate, groupByOp)
    }
    void init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router])

  async function loadOrphans() {
    setOL(true); setError(null)
    const token = await getAccessToken()
    if (!token) return
    const res = await fetch('/api/admin/storage/orphans', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = (await res.json()) as { orphans?: string[]; error?: string }
    if (!res.ok) { setError(data.error ?? 'Failed to load orphans.'); setOL(false); return }
    setOrphans(data.orphans ?? [])
    setOL(false)
  }

  async function runCleanup() {
    if (!orphans || orphans.length === 0) return
    setCleanupBusy(true); setError(null); setSuccess(null)
    const token = await getAccessToken()
    if (!token) return
    const res = await fetch('/api/admin/storage/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ paths: orphans }),
    })
    const data = (await res.json()) as { deleted?: number; errors?: string[]; error?: string }
    if (!res.ok) { setError(data.error ?? 'Cleanup failed.'); setCleanupBusy(false); return }
    setSuccess(`Deleted ${data.deleted ?? 0} orphan file(s).`)
    setOrphans([])
    setCleanupBusy(false)
  }

  if (loading) return <div style={S.page}><p style={S.muted}>Loading…</p></div>
  if (forbidden) return (
    <div style={S.page}>
      <div style={S.errBanner}>403 — You do not have permission to view this page.</div>
    </div>
  )

  const tokenRows = aiData?.rows.filter(r => r.unit === 'tokens') ?? []
  const audioRows = aiData?.rows.filter(r => r.unit === 'audio_seconds') ?? []

  return (
    <div style={S.page}>
      <div style={S.pageHeader}>
        <h1 style={S.h1}>Usage & Storage</h1>
        <span style={S.adminBadge}>Admin only</span>
      </div>

      {error && (
        <div style={S.errBanner}>
          ✗ {error}
          <button style={S.dismissBtn} onClick={() => setError(null)}>✕</button>
        </div>
      )}
      {success && (
        <div style={S.successBanner}>
          ✓ {success}
          <button style={S.dismissBtn} onClick={() => setSuccess(null)}>✕</button>
        </div>
      )}

      {/* ── AI Provider Usage ──────────────────────────────────────────────── */}
      <section style={S.section}>
        <h2 style={S.h2}>AI Provider Usage</h2>
        <p style={S.subtitle}>
          Token counts (Gemini) and audio duration (Speechmatics) are shown separately
          and are never combined into a single number.
        </p>

        {/* Controls */}
        <div style={S.controls}>
          <label style={S.label}>
            From
            <input
              type="date"
              style={S.dateInput}
              value={fromDate}
              max={toDate}
              onChange={e => setFromDate(e.target.value)}
            />
          </label>
          <label style={S.label}>
            To
            <input
              type="date"
              style={S.dateInput}
              value={toDate}
              min={fromDate}
              max={todayIso()}
              onChange={e => setToDate(e.target.value)}
            />
          </label>
          <label style={{ ...S.label, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={groupByOp}
              onChange={e => setGroupByOp(e.target.checked)}
            />
            Break down by operation
          </label>
          <button
            style={S.btn}
            disabled={aiLoading}
            onClick={() => void fetchAiUsage(fromDate, toDate, groupByOp)}
          >
            {aiLoading ? 'Loading…' : 'Apply'}
          </button>
        </div>

        {aiData && (
          <>
            {/* Summary tiles */}
            <div style={S.tileRow}>
              <Tile label="Gemini calls"     value={String(tokenRows.reduce((s, r) => s + r.calls, 0))} />
              <Tile label="Total tokens"     value={fmtTokens(tokenRows.reduce((s, r) => s + (r.total_tokens ?? 0), 0))} />
              <Tile label="Input tokens"     value={fmtTokens(tokenRows.reduce((s, r) => s + (r.total_input_tokens ?? 0), 0))} />
              <Tile label="Output tokens"    value={fmtTokens(tokenRows.reduce((s, r) => s + (r.total_output_tokens ?? 0), 0))} />
              <Tile label="STT calls"        value={String(audioRows.reduce((s, r) => s + r.calls, 0))} />
              <Tile label="Audio transcribed" value={fmtMinutes(audioRows.reduce((s, r) => s + (r.total_audio_seconds ?? 0), 0))} />
              <Tile
                label="Rate-limited (429)"
                value={String(aiData.rows.reduce((s, r) => s + r.rate_limited_count, 0))}
                accent={aiData.rows.some(r => r.rate_limited_count > 0)}
              />
              <Tile
                label="Errors"
                value={String(aiData.rows.reduce((s, r) => s + r.error_count, 0))}
                accent={aiData.rows.some(r => r.error_count > 0)}
              />
            </div>

            {/* Detail table */}
            <AiUsageTable rows={aiData.rows} />

            {/* Trend charts */}
            {aiData.dailyTotals.length > 0 && (
              <>
                {tokenRows.length > 0 && (
                  <div style={{ marginTop: 20 }}>
                    <h3 style={S.h3}>Token usage per day</h3>
                    <TrendChart
                      dailyTotals={aiData.dailyTotals}
                      unit="tokens"
                      from={toDateInput(aiData.from)}
                      to={toDateInput(aiData.to)}
                    />
                  </div>
                )}
                {audioRows.length > 0 && (
                  <div style={{ marginTop: 20 }}>
                    <h3 style={S.h3}>Audio transcribed per day (seconds)</h3>
                    <TrendChart
                      dailyTotals={aiData.dailyTotals}
                      unit="audio_seconds"
                      from={toDateInput(aiData.from)}
                      to={toDateInput(aiData.to)}
                    />
                  </div>
                )}
              </>
            )}
          </>
        )}
      </section>

      {/* ── Meeting stats ──────────────────────────────────────────────────── */}
      {meetings && (
        <section style={S.section}>
          <h2 style={S.h2}>Meetings</h2>
          <div style={S.tileRow}>
            <Tile label="Total"       value={String(meetings.total)} />
            <Tile label="Last 7 days" value={String(meetings.last7Days)} />
            <Tile label="Last 30 days" value={String(meetings.last30Days)} />
            <Tile label="Failure rate" value={`${(meetings.failureRate * 100).toFixed(1)}%`} accent={meetings.failureRate > 0.1} />
          </div>
          <h3 style={S.h3}>By status</h3>
          <div style={S.tileRow}>
            {Object.entries(meetings.byStatus).map(([status, count]) => (
              <Tile key={status} label={status} value={String(count)} />
            ))}
          </div>
        </section>
      )}

      {/* ── Storage stats ──────────────────────────────────────────────────── */}
      {storage && (
        <section style={S.section}>
          <h2 style={S.h2}>Storage</h2>
          <div style={S.tileRow}>
            <Tile label="Files"      value={String(storage.fileCount)} />
            <Tile label="Total size" value={formatBytes(storage.totalBytes)} />
          </div>
        </section>
      )}

      {/* ── Orphan management ──────────────────────────────────────────────── */}
      <section style={S.section}>
        <h2 style={S.h2}>Orphan Files</h2>
        <p style={S.subtitle}>
          Storage files that have no corresponding meeting row can be safely deleted.
        </p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button style={S.btn} onClick={() => { void loadOrphans() }} disabled={orphansLoading}>
            {orphansLoading ? 'Scanning…' : 'Scan for orphans'}
          </button>
          {orphans !== null && orphans.length > 0 && (
            <button
              style={{ ...S.btn, background: '#dc2626', color: '#fff', border: 'none' }}
              onClick={() => { void runCleanup() }}
              disabled={cleanupBusy}
            >
              {cleanupBusy ? 'Deleting…' : `Delete ${orphans.length} orphan(s)`}
            </button>
          )}
        </div>
        {orphans !== null && (
          orphans.length === 0 ? (
            <p style={{ ...S.muted, fontSize: 13 }}>No orphan files found.</p>
          ) : (
            <div style={S.orphanList}>
              {orphans.map((path) => (
                <div key={path} style={S.orphanItem}>{path}</div>
              ))}
            </div>
          )
        )}
      </section>
    </div>
  )
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ ...S.tile, ...(accent ? S.tileAccent : {}) }}>
      <div style={S.tileValue}>{value}</div>
      <div style={S.tileLabel}>{label}</div>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S: Record<string, CSSProperties> = {
  page:       { padding: '28px 32px', maxWidth: 960 },
  pageHeader: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 },
  h1:         { margin: 0, fontSize: 20, fontWeight: 700, color: '#0f172a' },
  h2:         { margin: '0 0 14px', fontSize: 16, fontWeight: 600, color: '#1e293b' },
  h3:         { margin: '16px 0 10px', fontSize: 13, fontWeight: 600, color: '#475569' },
  adminBadge: {
    fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
    background: '#fee2e2', color: '#991b1b', padding: '3px 8px', borderRadius: 99,
  },
  badge: {
    fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
    padding: '2px 7px', borderRadius: 99, display: 'inline-block',
  },
  subtitle:   { margin: '0 0 14px', fontSize: 13, color: '#64748b' },
  muted:      { color: '#888', fontSize: 14 },
  section:    { marginBottom: 36 },
  tileRow:    { display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 },
  tile: {
    background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
    padding: '14px 18px', minWidth: 110, textAlign: 'center',
  },
  tileAccent: { border: '1px solid #f87171', background: '#fff5f5' },
  tileValue:  { fontSize: 20, fontWeight: 700, color: '#0f172a' },
  tileLabel:  { fontSize: 11, color: '#64748b', marginTop: 4, textTransform: 'capitalize' },

  // Controls row
  controls: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 16 },
  label:    { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: '#475569', fontWeight: 500 },
  dateInput: {
    border: '1px solid #d0d0d0', borderRadius: 6, padding: '5px 8px',
    fontSize: 13, color: '#1e293b', background: '#fff',
  },

  // Table
  tableWrap: { overflowX: 'auto', marginBottom: 6 },
  table:     { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: {
    textAlign: 'left', padding: '8px 10px',
    background: '#f8fafc', borderBottom: '1px solid #e2e8f0',
    color: '#475569', fontWeight: 600, fontSize: 12,
    whiteSpace: 'nowrap',
  },
  td:     { padding: '7px 10px', borderBottom: '1px solid #f1f5f9', color: '#334155', whiteSpace: 'nowrap' },
  rowAlt: { background: '#fafafa' },
  code:   { fontFamily: 'monospace', fontSize: 12, background: '#f1f5f9', padding: '1px 5px', borderRadius: 4 },
  warn:   { color: '#92400e', fontWeight: 600 },
  err:    { color: '#991b1b', fontWeight: 600 },

  // Banners
  errBanner: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    background: '#fff0f0', border: '1px solid #f55', borderRadius: 6,
    padding: '10px 14px', color: '#b00020', fontSize: 14, marginBottom: 12,
  },
  successBanner: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    background: '#f0fff4', border: '1px solid #1a7f37', borderRadius: 6,
    padding: '10px 14px', color: '#166534', fontSize: 14, marginBottom: 12,
  },
  dismissBtn: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: 'inherit', opacity: 0.6 },
  btn: {
    fontSize: 13, padding: '7px 14px', border: '1px solid #d0d0d0',
    borderRadius: 6, background: '#fff', cursor: 'pointer', color: '#333', fontWeight: 500,
  },

  // Orphans
  orphanList: {
    background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8,
    maxHeight: 240, overflowY: 'auto', padding: '8px 12px',
  },
  orphanItem: { fontFamily: 'monospace', fontSize: 12, color: '#334155', padding: '3px 0' },
}
