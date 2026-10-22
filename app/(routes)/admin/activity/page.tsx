'use client'

import type { CSSProperties } from 'react'
import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { getAccessToken } from '@/lib/supabase/auth'

// ── Types ───────────────────────────────────────────────────────────────────────

type ActivityRow = {
  id: string
  created_at: string
  user_id: string
  event_type: string
  meeting_id: string | null
  meeting_title: string | null
  target_user_id: string | null
  metadata: Record<string, unknown> | null
  ip: string | null
  user_agent: string | null
}

// ── Constants ───────────────────────────────────────────────────────────────────

const PER_PAGE = 25

const EVENT_BADGE_COLOR: Record<string, string> = {
  login:              '#dcfce7',
  logout:             '#f1f5f9',
  record_start:       '#dbeafe',
  record_stop:        '#ede9fe',
  recording_notice_ack: '#e0f2fe',
  meeting_created:    '#fef9c3',
  processing_done:    '#d1fae5',
  processing_failed:  '#fee2e2',
  chat_message:       '#fce7f3',
  meeting_deleted:    '#fee2e2',
  meeting_shared:     '#cffafe',
  meeting_unshared:   '#f1f5f9',
}

const EVENT_TEXT_COLOR: Record<string, string> = {
  processing_failed: '#991b1b',
  meeting_deleted:   '#991b1b',
  login:             '#166534',
  processing_done:   '#065f46',
}

// ── Page ────────────────────────────────────────────────────────────────────────

export default function ActivityFeedPage() {
  const [rows, setRows]       = useState<ActivityRow[]>([])
  const [total, setTotal]     = useState(0)
  const [page, setPage]       = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)

  // Filters
  const [filterUser,  setFilterUser]  = useState('')
  const [filterEvent, setFilterEvent] = useState('')
  const [filterFrom,  setFilterFrom]  = useState('')
  const [filterTo,    setFilterTo]    = useState('')

  const fetch_ = useCallback(async (p: number, user: string, event: string, from: string, to: string) => {
    setLoading(true)
    setError(null)
    try {
      const token = await getAccessToken()
      if (!token) { setLoading(false); return }
      const params = new URLSearchParams({ page: String(p), perPage: String(PER_PAGE) })
      if (user)  params.set('userId',    user)
      if (event) params.set('eventType', event)
      if (from)  params.set('from',      from)
      if (to)    params.set('to',        to)
      const res = await fetch(`/api/admin/activity?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = (await res.json()) as { rows?: ActivityRow[]; total?: number; error?: string }
      if (!res.ok) { setError(data.error ?? 'Failed to load activity.'); return }
      setRows(data.rows ?? [])
      setTotal(data.total ?? 0)
    } catch {
      setError('Network error — please try again.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void fetch_(1, '', '', '', '') }, [fetch_])

  function applyFilters() {
    setPage(1)
    void fetch_(1, filterUser, filterEvent, filterFrom, filterTo)
  }

  function changePage(p: number) {
    setPage(p)
    void fetch_(p, filterUser, filterEvent, filterFrom, filterTo)
  }

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE))

  return (
    <div style={S.page}>
      <div style={S.header}>
        <div>
          <h1 style={S.title}>Activity Feed</h1>
          <p style={S.subtitle}>All user activity events across the system</p>
        </div>
        <span style={S.totalBadge}>{total.toLocaleString()} events</span>
      </div>

      {/* Filters */}
      <div style={S.filters}>
        <input
          style={S.input}
          placeholder="Filter by user ID…"
          value={filterUser}
          onChange={(e) => setFilterUser(e.target.value)}
        />
        <select style={S.select} value={filterEvent} onChange={(e) => setFilterEvent(e.target.value)}>
          <option value="">All event types</option>
          {['login','logout','record_start','record_stop','recording_notice_ack','meeting_created','processing_done','processing_failed','chat_message','meeting_deleted','meeting_shared','meeting_unshared'].map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <input type="date" style={S.input} value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} title="From date" />
        <input type="date" style={S.input} value={filterTo}   onChange={(e) => setFilterTo(e.target.value)}   title="To date" />
        <button style={S.applyBtn} onClick={applyFilters}>Apply</button>
      </div>

      {error && <div style={S.errBanner}>{error}</div>}

      {loading ? (
        <p style={S.muted}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={S.muted}>No activity events found.</p>
      ) : (
        <>
          <div style={S.tableWrap}>
            <table style={S.table}>
              <thead>
                <tr>
                  {['Time (UTC)', 'Event', 'User', 'Meeting', 'IP', 'Metadata'].map((h) => (
                    <th key={h} style={S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td style={{ ...S.td, whiteSpace: 'nowrap', color: '#64748b', fontSize: 12 }}>
                      {fmtFull(row.created_at)}
                    </td>
                    <td style={S.td}>
                      <span style={eventBadgeStyle(row.event_type)}>{row.event_type}</span>
                    </td>
                    <td style={{ ...S.td, fontSize: 12 }}>
                      <Link href={`/admin/users/${row.user_id}`} style={S.userLink}>
                        {row.user_id.slice(0, 8)}…
                      </Link>
                    </td>
                    <td style={{ ...S.td, fontSize: 12, color: '#64748b' }}>
                      {row.meeting_title ?? (row.meeting_id ? (
                        <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#94a3b8' }}>
                          {row.meeting_id.slice(0, 8)}…
                        </span>
                      ) : '—')}
                    </td>
                    <td style={{ ...S.td, fontSize: 11, color: '#94a3b8', fontFamily: 'monospace' }}>
                      {row.ip ?? '—'}
                    </td>
                    <td style={{ ...S.td, fontSize: 11, color: '#94a3b8', maxWidth: 240 }}>
                      {row.metadata
                        ? <pre style={S.metaPre}>{JSON.stringify(row.metadata, null, 2)}</pre>
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div style={S.pagination}>
              <button style={S.pageBtn} disabled={page <= 1} onClick={() => changePage(page - 1)}>← Prev</button>
              <span style={S.pageLabel}>Page {page} of {totalPages} ({total.toLocaleString()} events)</span>
              <button style={S.pageBtn} disabled={page >= totalPages} onClick={() => changePage(page + 1)}>Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtFull(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function eventBadgeStyle(type: string): CSSProperties {
  return {
    display: 'inline-block',
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 7px',
    borderRadius: 4,
    fontFamily: 'monospace',
    background: EVENT_BADGE_COLOR[type] ?? '#f1f5f9',
    color: EVENT_TEXT_COLOR[type] ?? '#334155',
  }
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const S: Record<string, CSSProperties> = {
  page: { padding: '24px 32px', maxWidth: 1200 },

  header: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    marginBottom: 24, flexWrap: 'wrap', gap: 12,
  },
  title: { margin: '0 0 4px', fontSize: 22, fontWeight: 700, color: '#0f172a' },
  subtitle: { margin: 0, fontSize: 13, color: '#64748b' },
  totalBadge: {
    fontSize: 12, fontWeight: 600, background: '#e2e8f0', color: '#475569',
    padding: '5px 12px', borderRadius: 99, alignSelf: 'flex-start',
  },

  filters: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20, alignItems: 'center' },
  input: {
    padding: '7px 11px', borderRadius: 6, border: '1px solid #cbd5e1',
    fontSize: 13, color: '#0f172a', background: '#fff', outline: 'none',
    minWidth: 160,
  },
  select: {
    padding: '7px 11px', borderRadius: 6, border: '1px solid #cbd5e1',
    fontSize: 13, color: '#0f172a', background: '#fff', outline: 'none',
  },
  applyBtn: {
    padding: '7px 16px', background: '#0f172a', color: '#f1f5f9',
    border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },

  errBanner: {
    background: '#fff0f0', border: '1px solid #f55', borderRadius: 6,
    padding: '10px 14px', color: '#b00020', fontSize: 14, marginBottom: 16,
  },
  muted: { color: '#94a3b8', fontSize: 14 },

  tableWrap: { overflowX: 'auto', background: '#fff', borderRadius: 8, border: '1px solid #e2e8f0', marginBottom: 16 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: {
    textAlign: 'left', padding: '10px 12px', fontWeight: 600, whiteSpace: 'nowrap',
    background: '#f8fafc', borderBottom: '1px solid #e2e8f0', color: '#475569', fontSize: 12,
  },
  td: { padding: '10px 12px', borderBottom: '1px solid #f1f5f9', verticalAlign: 'top' },

  userLink: { color: '#2563eb', textDecoration: 'none', fontFamily: 'monospace', fontSize: 12 },

  metaPre: {
    margin: 0, fontSize: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
    maxHeight: 60, overflowY: 'auto', color: '#64748b',
  },

  pagination: {
    display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center',
    marginTop: 4, marginBottom: 20,
  },
  pageBtn: {
    fontSize: 13, padding: '5px 14px', border: '1px solid #d0d0d0',
    borderRadius: 6, background: '#fff', cursor: 'pointer', color: '#333',
  },
  pageLabel: { fontSize: 13, color: '#555' },
}
