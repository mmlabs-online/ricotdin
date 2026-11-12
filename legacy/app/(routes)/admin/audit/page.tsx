'use client'

import type { CSSProperties } from 'react'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { getAccessToken, getCurrentRole } from '@/lib/supabase/auth'

// ── Types ─────────────────────────────────────────────────────────────────────

type AuditLog = {
  id: string
  actor_id: string | null
  actor_email: string | null
  action: string
  target_type: string | null
  target_id: string | null
  metadata: Record<string, unknown> | null
  ip_address: string | null
  user_agent: string | null
  created_at: string
}

// ── Page ──────────────────────────────────────────────────────────────────────

const PER_PAGE = 20

export default function AuditLogPage() {
  const router = useRouter()

  const [loading, setLoading]     = useState(true)
  const [forbidden, setForbidden] = useState(false)
  const [logs, setLogs]           = useState<AuditLog[]>([])
  const [total, setTotal]         = useState(0)
  const [error, setError]         = useState<string | null>(null)

  const [page, setPage]           = useState(1)
  const [actionFilter, setActionFilter] = useState('')
  const [actorFilter, setActorFilter]   = useState('')

  const fetchLogs = useCallback(async (p: number, action: string, actor: string) => {
    const token = await getAccessToken()
    if (!token) { router.replace('/login'); return }

    const params = new URLSearchParams({
      page: String(p),
      perPage: String(PER_PAGE),
    })
    if (action) params.set('action', action)
    if (actor)  params.set('actor', actor)

    const res = await fetch(`/api/admin/audit-logs?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.status === 403) { setForbidden(true); return }
    const data = (await res.json()) as { logs?: AuditLog[]; total?: number; error?: string }
    if (!res.ok) { setError(data.error ?? 'Failed to load audit logs.'); return }
    setLogs(data.logs ?? [])
    setTotal(data.total ?? 0)
  }, [router])

  useEffect(() => {
    async function init() {
      const role = await getCurrentRole()
      if (role !== 'admin') { setForbidden(true); setLoading(false); return }
      await fetchLogs(1, '', '')
      setLoading(false)
    }
    void init()
  }, [fetchLogs])

  function applyFilters() {
    setPage(1)
    void fetchLogs(1, actionFilter, actorFilter)
  }

  function changePage(next: number) {
    setPage(next)
    void fetchLogs(next, actionFilter, actorFilter)
  }

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE))

  if (loading) return <div style={S.page}><p style={S.muted}>Loading…</p></div>
  if (forbidden) return (
    <div style={S.page}>
      <div style={S.errBanner}>403 — You do not have permission to view this page.</div>
    </div>
  )

  return (
    <div style={S.page}>
      <div style={S.pageHeader}>
        <h1 style={S.h1}>Audit Log</h1>
        <span style={S.badge}>Admin only</span>
      </div>
      <p style={S.subtitle}>Every admin action is recorded here for accountability.</p>

      {error && (
        <div style={S.errBanner}>
          ✗ {error}
          <button style={S.dismissBtn} onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {/* Filters */}
      <div style={S.toolbar}>
        <input
          style={S.input}
          placeholder="Filter by action prefix (e.g. user.)"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && applyFilters()}
        />
        <input
          style={S.input}
          placeholder="Filter by actor UUID"
          value={actorFilter}
          onChange={(e) => setActorFilter(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && applyFilters()}
        />
        <button style={S.applyBtn} onClick={applyFilters}>Apply</button>
        <span style={S.countLabel}>{total} {total === 1 ? 'entry' : 'entries'}</span>
      </div>

      {/* Table */}
      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              {['Time (GMT+7)', 'Action', 'Actor', 'Target', 'IP', 'Details'].map((h) => (
                <th key={h} style={S.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id}>
                <td style={S.td}><span style={S.mono}>{formatDate(log.created_at)}</span></td>
                <td style={S.td}><span style={S.actionBadge}>{log.action}</span></td>
                <td style={S.td}>
                  <div style={S.small}>{log.actor_email ?? '—'}</div>
                  {log.actor_id && <div style={{ ...S.small, color: '#aaa' }}>{log.actor_id.slice(0, 8)}…</div>}
                </td>
                <td style={S.td}>
                  {log.target_type && <div style={S.small}>{log.target_type}</div>}
                  {log.target_id && <div style={{ ...S.small, color: '#aaa' }}>{log.target_id.slice(0, 12)}…</div>}
                </td>
                <td style={S.td}><span style={S.mono}>{log.ip_address ?? '—'}</span></td>
                <td style={S.td}>
                  {log.metadata && (
                    <details>
                      <summary style={S.detailsSummary}>view</summary>
                      <pre style={S.pre}>{JSON.stringify(log.metadata, null, 2)}</pre>
                    </details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {logs.length === 0 && (
          <p style={{ ...S.muted, padding: '16px 12px' }}>No audit log entries found.</p>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={S.pagination}>
          <button style={S.pageBtn} disabled={page <= 1} onClick={() => changePage(page - 1)}>← Prev</button>
          <span style={S.pageLabel}>Page {page} of {totalPages}</span>
          <button style={S.pageBtn} disabled={page >= totalPages} onClick={() => changePage(page + 1)}>Next →</button>
        </div>
      )}
    </div>
  )
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Bangkok',
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S: Record<string, CSSProperties> = {
  page:       { padding: '28px 32px', maxWidth: 1200 },
  pageHeader: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 },
  h1:         { margin: 0, fontSize: 20, fontWeight: 700, color: '#0f172a' },
  badge: {
    fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
    background: '#fee2e2', color: '#991b1b', padding: '3px 8px', borderRadius: 99,
  },
  subtitle:   { margin: '0 0 18px', fontSize: 13, color: '#64748b' },
  muted:      { color: '#888', fontSize: 14 },
  errBanner: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    background: '#fff0f0', border: '1px solid #f55', borderRadius: 6,
    padding: '10px 14px', color: '#b00020', fontSize: 14, marginBottom: 12,
  },
  dismissBtn: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: 'inherit', opacity: 0.6 },
  toolbar:    { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' },
  input: {
    fontSize: 13, padding: '6px 10px', border: '1px solid #d0d0d0',
    borderRadius: 6, outline: 'none', minWidth: 220,
  },
  applyBtn: {
    fontSize: 13, padding: '6px 14px', border: '1px solid #3b82f6',
    borderRadius: 6, background: '#3b82f6', color: '#fff', cursor: 'pointer', fontWeight: 500,
  },
  countLabel: { fontSize: 13, color: '#888', marginLeft: 4 },
  tableWrap:  { overflowX: 'auto', background: '#fff', borderRadius: 8, border: '1px solid #e2e8f0' },
  table:      { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: {
    textAlign: 'left', padding: '8px 12px', fontWeight: 600, whiteSpace: 'nowrap',
    background: '#f8fafc', borderBottom: '1px solid #e2e8f0', color: '#475569', fontSize: 11,
  },
  td:         { padding: '8px 12px', borderBottom: '1px solid #f1f5f9', verticalAlign: 'top' },
  mono:       { fontFamily: 'monospace', fontSize: 11, color: '#334155' },
  small:      { fontSize: 12, color: '#334155' },
  actionBadge: {
    fontFamily: 'monospace', fontSize: 11, background: '#f1f5f9',
    border: '1px solid #e2e8f0', borderRadius: 4, padding: '1px 6px', color: '#334155',
  },
  detailsSummary: { cursor: 'pointer', fontSize: 11, color: '#3b82f6' },
  pre:        { margin: '6px 0 0', fontSize: 10, background: '#f8fafc', padding: 8, borderRadius: 4, maxWidth: 300, overflowX: 'auto' },
  pagination: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, justifyContent: 'center' },
  pageBtn:    { fontSize: 13, padding: '5px 14px', border: '1px solid #d0d0d0', borderRadius: 6, background: '#fff', cursor: 'pointer', color: '#333' },
  pageLabel:  { fontSize: 13, color: '#555' },
}
