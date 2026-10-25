'use client'

import type { CSSProperties } from 'react'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { getAccessToken, getCurrentRole } from '@/lib/supabase/auth'
import { formatUptimeSecs } from '@/lib/admin/health'

// ── Types ─────────────────────────────────────────────────────────────────────

type CheckResult = {
  status: 'ok' | 'error'
  message?: string
}

type HealthReport = {
  status: 'ok' | 'degraded'
  ts: string
  checks: Record<string, CheckResult>
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function HealthPage() {
  const router = useRouter()

  const [loading, setLoading]       = useState(true)
  const [forbidden, setForbidden]   = useState(false)
  const [report, setReport]         = useState<HealthReport | null>(null)
  const [error, setError]           = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [uptime, setUptime]         = useState(0)

  const fetchHealth = useCallback(async () => {
    const token = await getAccessToken()
    if (!token) { router.replace('/login'); return }
    setRefreshing(true); setError(null)
    const res = await fetch('/api/admin/health', {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.status === 403) { setForbidden(true); setRefreshing(false); return }
    const data = (await res.json()) as HealthReport & { error?: string }
    if (!res.ok && !data.status) { setError(data.error ?? 'Failed to fetch health.'); setRefreshing(false); return }
    setReport(data)
    setRefreshing(false)
  }, [router])

  useEffect(() => {
    async function init() {
      const role = await getCurrentRole()
      if (role !== 'admin') { setForbidden(true); setLoading(false); return }
      await fetchHealth()
      setLoading(false)
    }
    void init()
  }, [fetchHealth])

  // Uptime counter (client-side wall-clock since page load)
  useEffect(() => {
    const start = Date.now()
    const id = setInterval(() => {
      setUptime(Math.floor((Date.now() - start) / 1000))
    }, 1000)
    return () => clearInterval(id)
  }, [])

  if (loading) return <div style={S.page}><p style={S.muted}>Loading…</p></div>
  if (forbidden) return (
    <div style={S.page}>
      <div style={S.errBanner}>403 — You do not have permission to view this page.</div>
    </div>
  )

  const overallOk = report?.status === 'ok'

  return (
    <div style={S.page}>
      <div style={S.pageHeader}>
        <h1 style={S.h1}>System Health</h1>
        <span style={S.badge}>Admin only</span>
      </div>

      {error && (
        <div style={S.errBanner}>
          ✗ {error}
          <button style={S.dismissBtn} onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {/* Overall status */}
      {report && (
        <div style={{ ...S.overallCard, ...(overallOk ? S.overallOk : S.overallDegraded) }}>
          <span style={S.overallDot}>{overallOk ? '●' : '●'}</span>
          <span style={S.overallText}>
            {overallOk ? 'All systems operational' : 'System degraded — check checks below'}
          </span>
          <span style={S.overallTime}>Last checked: {formatDate(report.ts)}</span>
        </div>
      )}

      {/* Per-service checks */}
      {report && (
        <section style={S.section}>
          <h2 style={S.h2}>Service checks</h2>
          <div style={S.checkList}>
            {Object.entries(report.checks).map(([name, check]) => (
              <div key={name} style={S.checkRow}>
                <span style={check.status === 'ok' ? S.dotOk : S.dotErr}>
                  {check.status === 'ok' ? '✓' : '✗'}
                </span>
                <div>
                  <div style={S.checkName}>{name}</div>
                  {check.message && <div style={S.checkMsg}>{check.message}</div>}
                </div>
                <span style={check.status === 'ok' ? S.statusOk : S.statusErr}>
                  {check.status}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Page uptime */}
      <section style={S.section}>
        <h2 style={S.h2}>Page uptime</h2>
        <p style={S.muted}>{formatUptimeSecs(uptime)} since this page was opened.</p>
      </section>

      {/* Refresh */}
      <button style={S.refreshBtn} onClick={() => { void fetchHealth() }} disabled={refreshing}>
        {refreshing ? 'Refreshing…' : 'Refresh now'}
      </button>
    </div>
  )
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const S: Record<string, CSSProperties> = {
  page:         { padding: '28px 32px', maxWidth: 700 },
  pageHeader:   { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 },
  h1:           { margin: 0, fontSize: 20, fontWeight: 700, color: '#0f172a' },
  h2:           { margin: '0 0 14px', fontSize: 16, fontWeight: 600, color: '#1e293b' },
  badge: {
    fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
    background: '#fee2e2', color: '#991b1b', padding: '3px 8px', borderRadius: 99,
  },
  muted:        { color: '#64748b', fontSize: 13 },
  section:      { marginBottom: 28 },
  overallCard: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px',
    borderRadius: 10, marginBottom: 24, border: '1px solid transparent',
  },
  overallOk: { background: '#f0fdf4', border: '1px solid #bbf7d0' },
  overallDegraded: { background: '#fef9c3', border: '1px solid #fde68a' },
  overallDot:   { fontSize: 18, lineHeight: 1 },
  overallText:  { flex: 1, fontSize: 14, fontWeight: 600, color: '#1e293b' },
  overallTime:  { fontSize: 12, color: '#64748b' },
  checkList:    { display: 'flex', flexDirection: 'column', gap: 8 },
  checkRow: {
    display: 'flex', alignItems: 'flex-start', gap: 12,
    background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '12px 16px',
  },
  dotOk:        { fontSize: 16, color: '#16a34a', lineHeight: 1.4, fontWeight: 700 },
  dotErr:       { fontSize: 16, color: '#dc2626', lineHeight: 1.4, fontWeight: 700 },
  checkName:    { fontSize: 14, fontWeight: 600, color: '#1e293b', textTransform: 'capitalize' },
  checkMsg:     { fontSize: 12, color: '#dc2626', marginTop: 2 },
  statusOk:     { marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: '#166534', background: '#dcfce7', padding: '2px 8px', borderRadius: 99 },
  statusErr:    { marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: '#991b1b', background: '#fee2e2', padding: '2px 8px', borderRadius: 99 },
  refreshBtn: {
    fontSize: 13, padding: '8px 18px', border: '1px solid #3b82f6',
    borderRadius: 6, background: '#3b82f6', color: '#fff', cursor: 'pointer', fontWeight: 500,
  },
  errBanner: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    background: '#fff0f0', border: '1px solid #f55', borderRadius: 6,
    padding: '10px 14px', color: '#b00020', fontSize: 14, marginBottom: 12,
  },
  dismissBtn: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: 'inherit', opacity: 0.6 },
}
