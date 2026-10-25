'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getCurrentRole, getAccessToken } from '@/lib/supabase/auth'

// ── Types ─────────────────────────────────────────────────────────────────────

type PipelineCounts = {
  pending: number
  processing: number
  done: number
  failed: number
  stuck: number
}

type OverviewData = {
  counts: PipelineCounts
  avg_processing_secs: number | null
  stuck_threshold_minutes: number
  total: number
}

type PipelineJob = {
  id: string
  title: string | null
  status: string
  created_at: string
  updated_at: string
  duration_seconds: number | null
  error_message: string | null
  owner_email: string | null
  owner_username: string | null
  is_stuck: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtSecs(secs: number | null): string {
  if (secs == null) return '—'
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

const STATUS_COLORS: Record<string, string> = {
  pending:    '#f59e0b',
  processing: '#2563eb',
  done:       '#16a34a',
  failed:     '#dc2626',
  stuck:      '#9333ea',
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PER_PAGE = 20
const STATUS_FILTERS = ['all', 'pending', 'processing', 'stuck', 'failed', 'done'] as const
type StatusFilter = typeof STATUS_FILTERS[number]

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PipelinePage() {
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)
  const [overview, setOverview] = useState<OverviewData | null>(null)
  const [jobs, setJobs] = useState<PipelineJob[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [requeueAllBusy, setRequeueAllBusy] = useState(false)
  const [confirmRequeueAll, setConfirmRequeueAll] = useState(false)

  // Cancelled when the component unmounts or a new refresh starts — prevents
  // in-flight requests from completing after the user navigates away.
  const abortRef = useRef<AbortController | null>(null)

  const fetchOverview = useCallback(async (token: string, signal: AbortSignal) => {
    const res = await fetch('/api/admin/pipeline/overview', {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    })
    if (!res.ok || signal.aborted) return
    const data = await res.json() as OverviewData
    setOverview(data)
  }, [])

  const fetchJobs = useCallback(async (token: string, status: StatusFilter, p: number, signal: AbortSignal) => {
    const params = new URLSearchParams({ page: String(p), perPage: String(PER_PAGE) })
    if (status !== 'all') params.set('status', status)
    const res = await fetch(`/api/admin/pipeline/jobs?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    })
    if (!res.ok || signal.aborted) return
    const data = await res.json() as { jobs: PipelineJob[]; total: number }
    setJobs(data.jobs)
    setTotal(data.total)
  }, [])

  const refresh = useCallback(async () => {
    // Cancel any previous in-flight fetch before starting a new one
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    const { signal } = abortRef.current

    const token = await getAccessToken()
    if (!token || signal.aborted) return
    setRefreshing(true)
    try {
      await Promise.all([
        fetchOverview(token, signal),
        fetchJobs(token, statusFilter, page, signal),
      ])
    } catch (err) {
      // AbortError is expected when navigating away — don't surface it as an error
      if (err instanceof Error && err.name !== 'AbortError') throw err
    } finally {
      if (!signal.aborted) setRefreshing(false)
    }
  }, [fetchOverview, fetchJobs, statusFilter, page])

  useEffect(() => {
    async function init() {
      const role = await getCurrentRole()
      if (role !== 'admin') { setForbidden(true); setLoading(false); return }

      await refresh()
      setLoading(false)
    }
    void init()
    return () => { abortRef.current?.abort() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch when filter or page changes (skip initial mount — init() handles that).
  const isFirstRender = useRef(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return }
    void refresh()
  }, [statusFilter, page])

  // ── Actions ─────────────────────────────────────────────────────────────────

  async function requeue(job: PipelineJob) {
    const token = await getAccessToken()
    if (!token) return
    setError(null); setSuccess(null); setBusyId(job.id)
    try {
      const res = await fetch(`/api/admin/pipeline/${job.id}/requeue`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json() as { error?: string }
      if (!res.ok) {
        setError(data.error ?? 'Requeue failed.')
      } else {
        setSuccess(`Meeting "${job.title ?? job.id.slice(0, 8)}" re-queued.`)
        await refresh()
      }
    } catch {
      setError('Network error — please try again.')
    } finally {
      setBusyId(null)
    }
  }

  async function requeueAll() {
    setConfirmRequeueAll(false)
    const token = await getAccessToken()
    if (!token) return
    setError(null); setSuccess(null); setRequeueAllBusy(true)

    // Fetch all stuck + failed job IDs
    try {
      const [stuckRes, failedRes] = await Promise.all([
        fetch('/api/admin/pipeline/jobs?status=stuck&perPage=100', {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch('/api/admin/pipeline/jobs?status=failed&perPage=100', {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ])
      const stuckData = stuckRes.ok ? await stuckRes.json() as { jobs: PipelineJob[] } : { jobs: [] }
      const failedData = failedRes.ok ? await failedRes.json() as { jobs: PipelineJob[] } : { jobs: [] }

      const allIds = [
        ...stuckData.jobs.map((j: PipelineJob) => j.id),
        ...failedData.jobs.map((j: PipelineJob) => j.id),
      ]
      const uniqueIds = [...new Set(allIds)]

      if (uniqueIds.length === 0) {
        setSuccess('No stuck or failed jobs to requeue.')
        setRequeueAllBusy(false)
        return
      }

      let succeeded = 0
      for (const id of uniqueIds) {
        const res = await fetch(`/api/admin/pipeline/${id}/requeue`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) succeeded++
      }

      setSuccess(`Re-queued ${succeeded} of ${uniqueIds.length} jobs.`)
      await refresh()
    } catch {
      setError('Network error during bulk requeue.')
    } finally {
      setRequeueAllBusy(false)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) return <div style={S.page}><p style={S.muted}>Loading…</p></div>

  if (forbidden) {
    return (
      <div style={S.page}>
        <div style={S.errBanner}>403 — You do not have permission to view this page.</div>
      </div>
    )
  }

  const counts = overview?.counts
  const stuckOrFailed = (counts?.stuck ?? 0) + (counts?.failed ?? 0)
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE))

  return (
    <div style={S.page}>
      {/* Page heading */}
      <div style={S.pageHeader}>
        <h1 style={S.h1}>Pipeline Monitor</h1>
        <span style={S.adminBadge}>Admin only</span>
      </div>

      {/* Banners */}
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

      {/* Status tiles */}
      {counts && (
        <div style={S.tiles}>
          {([
            ['Pending',    counts.pending,    'pending'],
            ['Processing', counts.processing, 'processing'],
            ['Stuck',      counts.stuck,      'stuck'],
            ['Failed',     counts.failed,     'failed'],
            ['Done',       counts.done,       'done'],
          ] as [string, number, string][]).map(([label, count, key]) => (
            <button
              key={key}
              style={{
                ...S.tile,
                borderTop: `3px solid ${STATUS_COLORS[key] ?? '#888'}`,
                boxShadow: statusFilter === key ? '0 0 0 2px ' + STATUS_COLORS[key] : S.tile.boxShadow,
              }}
              onClick={() => { setStatusFilter(key as StatusFilter); setPage(1) }}
            >
              <span style={{ ...S.tileCount, color: STATUS_COLORS[key] ?? '#333' }}>{count}</span>
              <span style={S.tileLabel}>{label}</span>
            </button>
          ))}
          {overview?.avg_processing_secs != null && (
            <div style={{ ...S.tile, borderTop: '3px solid #64748b' }}>
              <span style={{ ...S.tileCount, color: '#334155' }}>
                {fmtSecs(overview.avg_processing_secs)}
              </span>
              <span style={S.tileLabel}>Avg duration</span>
            </div>
          )}
        </div>
      )}

      {/* Toolbar */}
      <div style={S.toolbar}>
        <div style={{ display: 'flex', gap: 6 }}>
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              style={f === statusFilter ? { ...S.filterBtn, ...S.filterBtnActive } : S.filterBtn}
              onClick={() => { setStatusFilter(f); setPage(1) }}
            >
              {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
          <span style={S.muted}>{total} job{total !== 1 ? 's' : ''}</span>
          <button
            style={S.refreshBtn}
            disabled={refreshing}
            onClick={() => { void refresh() }}
          >
            {refreshing ? 'Refreshing…' : '↻ Refresh'}
          </button>
          {stuckOrFailed > 0 && (
            <button
              style={S.requeueAllBtn}
              disabled={requeueAllBusy}
              onClick={() => setConfirmRequeueAll(true)}
            >
              {requeueAllBusy ? 'Requeueing…' : `Requeue all stuck/failed (${stuckOrFailed})`}
            </button>
          )}
        </div>
      </div>

      {/* Jobs table */}
      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>Status</th>
              <th style={S.th}>Meeting</th>
              <th style={S.th}>Owner</th>
              <th style={S.th}>Created</th>
              <th style={S.th}>Duration</th>
              <th style={S.th}>Error</th>
              <th style={S.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => {
              const displayStatus = job.is_stuck ? 'stuck' : job.status
              const canRequeue = true
              return (
                <tr key={job.id} style={job.status === 'failed' ? S.failedRow : undefined}>
                  <td style={S.td}>
                    <span style={{
                      ...S.statusBadge,
                      background: (STATUS_COLORS[displayStatus] ?? '#888') + '22',
                      color: STATUS_COLORS[displayStatus] ?? '#888',
                    }}>
                      {displayStatus}
                    </span>
                  </td>
                  <td style={S.td}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#222' }}>
                      {job.title ?? <span style={S.muted}>(untitled)</span>}
                    </div>
                    <div style={{ ...S.muted, fontSize: 11, fontFamily: 'monospace' }}>
                      {job.id.slice(0, 8)}…
                    </div>
                  </td>
                  <td style={S.td}>
                    <div style={{ fontSize: 12 }}>{job.owner_email ?? <span style={S.muted}>—</span>}</div>
                    {job.owner_username && (
                      <div style={{ ...S.muted, fontSize: 11 }}>@{job.owner_username}</div>
                    )}
                  </td>
                  <td style={{ ...S.td, fontSize: 12, whiteSpace: 'nowrap' }}>
                    {fmtDate(job.created_at)}
                  </td>
                  <td style={{ ...S.td, fontSize: 12 }}>
                    {fmtSecs(job.duration_seconds)}
                  </td>
                  <td style={{ ...S.td, maxWidth: 240 }}>
                    {job.error_message ? (
                      <span style={S.errorText} title={job.error_message}>
                        {job.error_message.length > 80
                          ? job.error_message.slice(0, 80) + '…'
                          : job.error_message}
                      </span>
                    ) : (
                      <span style={S.muted}>—</span>
                    )}
                  </td>
                  <td style={S.td}>
                    {canRequeue && (
                      <button
                        style={S.requeueBtn}
                        disabled={busyId === job.id}
                        onClick={() => { void requeue(job) }}
                      >
                        {busyId === job.id ? 'Requeueing…' : 'Requeue'}
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {jobs.length === 0 && (
          <p style={{ ...S.muted, padding: '16px 12px' }}>
            {statusFilter !== 'all' ? `No ${statusFilter} jobs.` : 'No jobs found.'}
          </p>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={S.pagination}>
          <button style={S.pageBtn} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            ← Prev
          </button>
          <span style={S.pageLabel}>Page {page} of {totalPages}</span>
          <button style={S.pageBtn} disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            Next →
          </button>
        </div>
      )}

      {/* Requeue-all confirmation dialog */}
      {confirmRequeueAll && (
        <div style={S.overlay} onClick={() => setConfirmRequeueAll(false)}>
          <div style={S.dialog} onClick={(e) => e.stopPropagation()}>
            <h3 style={S.dialogTitle}>Requeue all stuck and failed jobs?</h3>
            <p style={S.dialogBody}>
              This will re-run processing for <strong>{stuckOrFailed}</strong> job
              {stuckOrFailed !== 1 ? 's' : ''}. Prior transcript and analysis data for
              those meetings will be cleared and regenerated. This cannot be undone.
            </p>
            <div style={S.dialogActions}>
              <button style={S.btn} onClick={() => setConfirmRequeueAll(false)}>Cancel</button>
              <button style={S.requeueConfirmBtn} onClick={() => { void requeueAll() }}>
                Requeue {stuckOrFailed} job{stuckOrFailed !== 1 ? 's' : ''}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  page: { padding: '28px 32px', maxWidth: 1100 },
  pageHeader: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 },
  h1: { margin: 0, fontSize: 20, fontWeight: 700, color: '#0f172a' },
  adminBadge: {
    fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
    background: '#fee2e2', color: '#991b1b', padding: '3px 8px', borderRadius: 99,
  },
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
  dismissBtn: {
    background: 'none', border: 'none', cursor: 'pointer', fontSize: 14,
    color: 'inherit', opacity: 0.6, padding: '0 2px',
  },
  tiles: { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 },
  tile: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
    padding: '14px 20px', background: '#fff', borderRadius: 8,
    border: '1px solid #e5e7eb', borderTop: '3px solid #888',
    cursor: 'pointer', minWidth: 90, boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
  },
  tileCount: { fontSize: 26, fontWeight: 700, lineHeight: 1 },
  tileLabel: { fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' },
  toolbar: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' },
  filterBtn: {
    fontSize: 12, padding: '4px 10px', border: '1px solid #d0d0d0',
    borderRadius: 6, background: '#fff', cursor: 'pointer', color: '#555',
  },
  filterBtnActive: { background: '#1d4ed8', color: '#fff', border: '1px solid #1d4ed8', fontWeight: 600 },
  muted: { color: '#9ca3af', fontSize: 13 },
  tableWrap: { overflowX: 'auto', background: '#fff', borderRadius: 8, border: '1px solid #e2e8f0' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: {
    textAlign: 'left', padding: '10px 12px', fontWeight: 600, whiteSpace: 'nowrap',
    background: '#f8fafc', borderBottom: '1px solid #e2e8f0', color: '#475569', fontSize: 12,
  },
  td: { padding: '10px 12px', borderBottom: '1px solid #f1f5f9', verticalAlign: 'middle' },
  failedRow: { background: '#fff8f8' },
  statusBadge: {
    display: 'inline-block', fontSize: 11, fontWeight: 700,
    padding: '2px 8px', borderRadius: 99, textTransform: 'uppercase', letterSpacing: '0.04em',
  },
  errorText: { fontSize: 11, color: '#dc2626', wordBreak: 'break-word' },
  btn: {
    fontSize: 11, padding: '4px 10px', border: '1px solid #d0d0d0',
    borderRadius: 5, background: '#fff', cursor: 'pointer', color: '#333',
  },
  requeueBtn: {
    fontSize: 11, padding: '4px 10px', background: '#2563eb', color: '#fff',
    border: 'none', borderRadius: 5, cursor: 'pointer', fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  refreshBtn: {
    fontSize: 12, padding: '5px 12px', background: '#fff', color: '#374151',
    border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer', fontWeight: 500,
  },
  requeueAllBtn: {
    fontSize: 12, padding: '5px 12px', background: '#7c3aed', color: '#fff',
    border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600,
  },
  requeueConfirmBtn: {
    fontSize: 13, padding: '7px 16px', background: '#7c3aed', color: '#fff',
    border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600,
  },
  pagination: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, justifyContent: 'center' },
  pageBtn: {
    fontSize: 13, padding: '5px 14px', border: '1px solid #d0d0d0',
    borderRadius: 6, background: '#fff', cursor: 'pointer', color: '#333',
  },
  pageLabel: { fontSize: 13, color: '#555' },
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
  },
  dialog: {
    background: '#fff', borderRadius: 10, padding: '24px 28px',
    maxWidth: 430, width: '90%', boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
  },
  dialogTitle: { margin: '0 0 12px', fontSize: 17, fontWeight: 700, color: '#111' },
  dialogBody: { margin: '0 0 20px', fontSize: 14, color: '#444', lineHeight: 1.6 },
  dialogActions: { display: 'flex', gap: 8, justifyContent: 'flex-end' },
}
