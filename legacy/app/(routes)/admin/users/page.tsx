'use client'

import type { CSSProperties } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { MoreVertical } from 'lucide-react'
import { browserClient } from '@/lib/supabase/browser'
import { getAccessToken, getCurrentRole } from '@/lib/supabase/auth'

// ── Types ─────────────────────────────────────────────────────────────────────

type UserStatus = 'unverified' | 'active' | 'disabled'

type AdminUser = {
  id: string
  email: string | null
  username: string | null
  role: 'user' | 'admin'
  disabled: boolean
  email_confirmed: boolean
  status: UserStatus
  meeting_count: number
  gemini_tokens: number
  audio_seconds: number
  created_at: string
  last_sign_in_at: string | null
}

type Confirm =
  | { type: 'delete'; user: AdminUser }
  | { type: 'reset-password'; user: AdminUser }
  | { type: 'role'; user: AdminUser; newRole: 'user' | 'admin' }
  | { type: 'status'; user: AdminUser; newDisabled: boolean }
  | { type: 'bulk'; action: BulkAction; role?: 'user' | 'admin'; count: number }

type BulkAction = 'disable' | 'enable' | 'set_role'

// Anchored, fixed-position row menu (avoids clipping by the table's overflow).
type RowMenu = { user: AdminUser; top: number; left: number }

// ── Page ──────────────────────────────────────────────────────────────────────

const PER_PAGE = 20
const MENU_WIDTH = 196

function currentMonthValue(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

function buildMonthOptions(count = 12): { value: string; label: string }[] {
  const now = new Date()
  const opts: { value: string; label: string }[] = []
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    const value = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    const label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    opts.push({ value, label })
  }
  return opts
}

export default function AdminPage() {
  const router = useRouter()

  const [loading, setLoading]       = useState(true)
  const [ready, setReady]           = useState(false)
  const [refetching, setRefetching] = useState(false)
  const [forbidden, setForbidden]   = useState(false)
  const [users, setUsers]           = useState<AdminUser[]>([])
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [error, setError]           = useState<string | null>(null)
  const [success, setSuccess]       = useState<string | null>(null)
  const [busyId, setBusyId]         = useState<string | null>(null)

  const [search, setSearch]         = useState('')
  const [roleFilter, setRoleFilter] = useState<'all' | 'user' | 'admin'>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | UserStatus>('all')
  const [month, setMonth]           = useState<string>(currentMonthValue())
  const [page, setPage]             = useState(1)

  const [selected, setSelected]     = useState<Set<string>>(new Set())
  const [bulkRole, setBulkRole]     = useState<'user' | 'admin'>('user')
  const [confirm, setConfirm]       = useState<Confirm | null>(null)
  const [bulkBusy, setBulkBusy]     = useState(false)
  const [menu, setMenu]             = useState<RowMenu | null>(null)

  const monthOptions = useMemo(() => buildMonthOptions(12), [])

  async function fetchUsers(usageMonth: string) {
    const token = await getAccessToken()
    if (!token) { router.replace('/login'); return }

    const res = await fetch(`/api/admin/users?perPage=1000&month=${encodeURIComponent(usageMonth)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.status === 403) { setForbidden(true); return }

    const data = (await res.json()) as { users?: AdminUser[]; error?: string }
    if (!res.ok) { setError(data.error ?? 'Failed to load users.'); return }
    setUsers(data.users ?? [])
  }

  // Role check + identity (runs once).
  useEffect(() => {
    async function init() {
      const role = await getCurrentRole()
      if (role !== 'admin') { setForbidden(true); setLoading(false); return }
      const { data: { session } } = await browserClient.auth.getSession()
      setCurrentUserId(session?.user.id ?? null)
      setReady(true)
    }
    void init()
  }, [])

  // Fetch (and re-fetch when the usage month changes).
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    async function run() {
      setRefetching(true)
      await fetchUsers(month)
      if (!cancelled) { setRefetching(false); setLoading(false) }
    }
    void run()
    return () => { cancelled = true }
  }, [ready, month]) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    return users.filter((u) => {
      if (q && !u.email?.toLowerCase().includes(q) && !u.username?.toLowerCase().includes(q)) return false
      if (roleFilter !== 'all' && u.role !== roleFilter) return false
      if (statusFilter !== 'all' && u.status !== statusFilter) return false
      return true
    })
  }, [users, search, roleFilter, statusFilter])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
  const paginated  = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE)

  function handleSearch(value: string) { setSearch(value); setPage(1); setSelected(new Set()) }
  function handleRoleFilter(v: string) { setRoleFilter(v as 'all' | 'user' | 'admin'); setPage(1); setSelected(new Set()) }
  function handleStatusFilter(v: string) { setStatusFilter(v as 'all' | UserStatus); setPage(1); setSelected(new Set()) }
  function handleMonth(v: string) { setMonth(v); setMenu(null) }

  // ── Row selection ──────────────────────────────────────────────────────────

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    const pageIds = paginated.filter((u) => u.id !== currentUserId).map((u) => u.id)
    const allSelected = pageIds.every((id) => selected.has(id))
    if (allSelected) {
      setSelected((prev) => { const next = new Set(prev); pageIds.forEach((id) => next.delete(id)); return next })
    } else {
      setSelected((prev) => { const next = new Set(prev); pageIds.forEach((id) => next.add(id)); return next })
    }
  }

  // ── Row menu ─────────────────────────────────────────────────────────────────

  function openMenu(user: AdminUser, e: React.MouseEvent) {
    e.stopPropagation()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const left = Math.max(8, r.right - MENU_WIDTH)
    setMenu({ user, top: r.bottom + 4, left })
  }

  // ── Per-row actions (each invoked after a confirm) ───────────────────────────

  async function changeRole(user: AdminUser, newRole: 'user' | 'admin') {
    const token = await getAccessToken()
    if (!token) return
    setConfirm(null); setError(null); setSuccess(null); setBusyId(user.id)
    const prevRole = user.role
    setUsers((prev) => prev.map((u) => u.id === user.id ? { ...u, role: newRole } : u))
    try {
      const res = await fetch(`/api/admin/users/${user.id}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ role: newRole }),
      })
      const data = (await res.json()) as { error?: string }
      if (!res.ok) {
        setUsers((prev) => prev.map((u) => u.id === user.id ? { ...u, role: prevRole } : u))
        setError(data.error ?? 'Failed to change role.')
      } else {
        setSuccess(`${user.email ?? user.username} is now ${newRole === 'admin' ? 'an admin' : 'a regular user'}.`)
      }
    } catch {
      setUsers((prev) => prev.map((u) => u.id === user.id ? { ...u, role: prevRole } : u))
      setError('Network error — please try again.')
    } finally {
      setBusyId(null)
    }
  }

  async function setDisabled(user: AdminUser, newDisabled: boolean) {
    const token = await getAccessToken()
    if (!token) return
    setConfirm(null); setError(null); setSuccess(null); setBusyId(user.id)
    const prevDisabled = user.disabled
    setUsers((prev) => prev.map((u) => u.id === user.id ? { ...u, disabled: newDisabled } : u))
    try {
      const res = await fetch(`/api/admin/users/${user.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ disabled: newDisabled }),
      })
      const data = (await res.json()) as { error?: string }
      if (!res.ok) {
        setUsers((prev) => prev.map((u) => u.id === user.id ? { ...u, disabled: prevDisabled } : u))
        setError(data.error ?? 'Failed to update account status.')
      } else {
        setSuccess(`${user.email ?? user.username} has been ${newDisabled ? 'disabled' : 're-enabled'}.`)
      }
    } catch {
      setUsers((prev) => prev.map((u) => u.id === user.id ? { ...u, disabled: prevDisabled } : u))
      setError('Network error — please try again.')
    } finally {
      setBusyId(null)
    }
  }

  async function sendPasswordReset(user: AdminUser) {
    const token = await getAccessToken()
    if (!token) return
    setConfirm(null); setError(null); setSuccess(null); setBusyId(user.id)
    try {
      const res = await fetch(`/api/admin/users/${user.id}/reset-password`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = (await res.json()) as { error?: string }
      if (!res.ok) {
        setError(data.error ?? 'Failed to send password reset.')
      } else {
        setSuccess(`Password reset email sent to ${user.email}.`)
      }
    } catch {
      setError('Network error — please try again.')
    } finally {
      setBusyId(null)
    }
  }

  async function deleteUser(user: AdminUser) {
    const token = await getAccessToken()
    if (!token) return
    setConfirm(null); setError(null); setSuccess(null); setBusyId(user.id)
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = (await res.json()) as { error?: string; storageWarnings?: string[] }
      if (!res.ok) {
        setError(data.error ?? 'Failed to delete user.')
      } else {
        setUsers((prev) => prev.filter((u) => u.id !== user.id))
        const warn = data.storageWarnings?.join(' ')
        setSuccess(`${user.email ?? user.username} has been deleted.${warn ? ` Warning: ${warn}` : ''}`)
      }
    } catch {
      setError('Network error — please try again.')
    } finally {
      setBusyId(null)
    }
  }

  // ── Bulk actions ───────────────────────────────────────────────────────────

  async function executeBulk(action: BulkAction, role?: 'user' | 'admin') {
    setConfirm(null)
    if (selected.size === 0) return
    setBulkBusy(true); setError(null); setSuccess(null)
    const token = await getAccessToken()
    if (!token) { setBulkBusy(false); return }

    const body: Record<string, unknown> = { ids: Array.from(selected), action }
    if (action === 'set_role') body.role = role

    try {
      const res = await fetch('/api/admin/users/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      const data = (await res.json()) as { processed?: number; skippedSelf?: string[]; errors?: { id: string; message: string }[]; error?: string }
      if (!res.ok) {
        setError(data.error ?? 'Bulk action failed.')
      } else {
        setSuccess(`Bulk ${action}: applied to ${data.processed ?? 0} user(s).${data.skippedSelf?.length ? ' (Skipped yourself)' : ''}`)
        setSelected(new Set())
        await fetchUsers(month)
      }
    } catch {
      setError('Network error — please try again.')
    } finally {
      setBulkBusy(false)
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

  const pageIds = paginated.filter((u) => u.id !== currentUserId).map((u) => u.id)
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id))
  const somePageSelected = pageIds.some((id) => selected.has(id))

  return (
    <div style={S.page}>
      {/* Page heading */}
      <div style={S.pageHeader}>
        <h1 style={S.h1}>User Management</h1>
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

      {/* Toolbar: search + filters */}
      <div style={S.toolbar}>
        <input
          style={S.searchInput}
          type="search"
          placeholder="Search by email or username…"
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
        />
        <select style={S.filterSelect} value={roleFilter} onChange={(e) => handleRoleFilter(e.target.value)}>
          <option value="all">All roles</option>
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </select>
        <select style={S.filterSelect} value={statusFilter} onChange={(e) => handleStatusFilter(e.target.value)}>
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="unverified">Unverified</option>
          <option value="disabled">Disabled</option>
        </select>
        <span style={S.divider} />
        <label style={S.usageLabel}>Usage month</label>
        <select style={S.filterSelect} value={month} onChange={(e) => handleMonth(e.target.value)} title="Choose which month's token / audio usage to display">
          {monthOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {refetching && <span style={S.muted}>Updating…</span>}
        <span style={S.countLabel}>
          {filtered.length} {filtered.length === 1 ? 'user' : 'users'}
          {search ? ` matching "${search}"` : ''}
        </span>
      </div>

      {/* Bulk-action bar */}
      {selected.size > 0 && (
        <div style={S.bulkBar}>
          <span style={S.bulkCount}>{selected.size} selected</span>
          <button style={S.bulkBtn} disabled={bulkBusy} onClick={() => setConfirm({ type: 'bulk', action: 'disable', count: selected.size })}>
            Disable
          </button>
          <button style={S.bulkBtn} disabled={bulkBusy} onClick={() => setConfirm({ type: 'bulk', action: 'enable', count: selected.size })}>
            Enable
          </button>
          <select style={S.filterSelect} value={bulkRole} onChange={(e) => setBulkRole(e.target.value as 'user' | 'admin')}>
            <option value="user">Set role: user</option>
            <option value="admin">Set role: admin</option>
          </select>
          <button style={{ ...S.bulkBtn, background: '#3b82f6', color: '#fff', border: 'none' }} disabled={bulkBusy} onClick={() => setConfirm({ type: 'bulk', action: 'set_role', role: bulkRole, count: selected.size })}>
            Apply role
          </button>
          <button style={{ ...S.bulkBtn, marginLeft: 'auto' }} onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}

      {/* Table */}
      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>
                <input
                  type="checkbox"
                  checked={allPageSelected}
                  ref={(el) => { if (el) el.indeterminate = somePageSelected && !allPageSelected }}
                  onChange={toggleSelectAll}
                />
              </th>
              <th style={S.th}>Email / Username</th>
              <th style={S.th}>Role</th>
              <th style={S.th}>Status</th>
              <th style={S.th}>Last sign-in</th>
              <th style={{ ...S.th, textAlign: 'right' }}>Gemini tokens</th>
              <th style={{ ...S.th, textAlign: 'right' }}>Script duration</th>
              <th style={{ ...S.th, textAlign: 'center' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {paginated.map((u) => {
              const isMe = u.id === currentUserId
              const isSelected = selected.has(u.id)
              return (
                <tr key={u.id} style={{ ...(u.disabled ? S.disabledRow : undefined), ...(isSelected ? S.selectedRow : undefined) }}>
                  <td style={S.td}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={isMe}
                      onChange={() => toggleSelect(u.id)}
                    />
                  </td>
                  <td style={S.td}>
                    <Link
                      href={`/admin/users/${u.id}`}
                      style={S.userLink}
                      title="View user details"
                      onMouseEnter={(e) => { e.currentTarget.style.background = '#f1f5f9' }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                    >
                      <span style={{ fontWeight: 500, fontSize: 13, color: '#1d4ed8' }}>
                        {u.email ?? '—'}
                        {isMe && <span style={S.youBadge}>You</span>}
                      </span>
                      {u.username && <span style={{ fontSize: 12, color: '#888' }}>@{u.username}</span>}
                    </Link>
                  </td>
                  <td style={S.td}>
                    <span style={u.role === 'admin' ? S.roleAdmin : S.roleUser}>{u.role}</span>
                  </td>
                  <td style={S.td}>
                    <div style={S.statusStack}>
                      {u.disabled
                        ? <span style={S.badgeDisabled}>Disabled</span>
                        : <span style={S.badgeActive}>Active</span>}
                      {u.email_confirmed
                        ? <span style={S.badgeVerified}>✓ Email verified</span>
                        : <span style={S.badgeUnverified}>Email unverified</span>}
                    </div>
                  </td>
                  <td style={S.td}>{u.last_sign_in_at ? formatDate(u.last_sign_in_at) : '—'}</td>
                  <td style={{ ...S.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {u.gemini_tokens > 0
                      ? <span title={`${u.gemini_tokens.toLocaleString('en-US')} tokens`}>{formatNumber(u.gemini_tokens)}</span>
                      : <span style={S.muted}>—</span>}
                  </td>
                  <td style={{ ...S.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {u.audio_seconds > 0
                      ? <span title={`${Math.round(u.audio_seconds)} seconds`}>{formatDuration(u.audio_seconds)}</span>
                      : <span style={S.muted}>—</span>}
                  </td>
                  <td style={{ ...S.td, textAlign: 'center' }}>
                    <button
                      style={S.kebabBtn}
                      aria-label="Actions"
                      title="Actions"
                      onClick={(e) => openMenu(u, e)}
                    >
                      <MoreVertical size={16} />
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {paginated.length === 0 && (
          <p style={{ ...S.muted, padding: '16px 12px' }}>
            {search || roleFilter !== 'all' || statusFilter !== 'all' ? 'No users match your filters.' : 'No users found.'}
          </p>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={S.pagination}>
          <button style={S.pageBtn} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Prev</button>
          <span style={S.pageLabel}>Page {page} of {totalPages}</span>
          <button style={S.pageBtn} disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next →</button>
        </div>
      )}

      {/* Row action menu (fixed-positioned; transparent overlay closes it) */}
      {menu && (() => {
        const u = menu.user
        const isMe = u.id === currentUserId
        return (
          <div style={S.menuOverlay} onClick={() => setMenu(null)}>
            <div style={{ ...S.menu, top: menu.top, left: menu.left }} onClick={(e) => e.stopPropagation()}>
              <Link href={`/admin/users/${u.id}`} style={S.menuItem} onClick={() => setMenu(null)}>
                View details
              </Link>
              {u.role === 'user' ? (
                <button style={S.menuItem} onClick={() => { setMenu(null); setConfirm({ type: 'role', user: u, newRole: 'admin' }) }}>
                  Make admin
                </button>
              ) : (
                <button style={menuItemDisable(isMe)} disabled={isMe} title={isMe ? 'Cannot demote yourself' : ''} onClick={() => { setMenu(null); setConfirm({ type: 'role', user: u, newRole: 'user' }) }}>
                  Make user
                </button>
              )}
              <button style={menuItemDisable(isMe)} disabled={isMe} title={isMe ? 'Cannot change your own status' : ''} onClick={() => { setMenu(null); setConfirm({ type: 'status', user: u, newDisabled: !u.disabled }) }}>
                {u.disabled ? 'Enable account' : 'Disable account'}
              </button>
              <button style={menuItemDisable(!u.email)} disabled={!u.email} title={!u.email ? 'No email on file' : ''} onClick={() => { setMenu(null); setConfirm({ type: 'reset-password', user: u }) }}>
                Reset password
              </button>
              <div style={S.menuSep} />
              <button style={{ ...menuItemDisable(isMe), color: isMe ? '#c0a0a0' : '#991b1b' }} disabled={isMe} title={isMe ? 'Cannot delete yourself' : ''} onClick={() => { setMenu(null); setConfirm({ type: 'delete', user: u }) }}>
                Delete user
              </button>
            </div>
          </div>
        )
      })()}

      {/* Confirmation dialogs */}
      {confirm && (
        <div style={S.overlay} onClick={() => setConfirm(null)}>
          <div style={S.dialog} onClick={(e) => e.stopPropagation()}>
            {confirm.type === 'delete' ? (
              <>
                <h3 style={S.dialogTitle}>Delete user?</h3>
                <p style={S.dialogBody}>
                  <strong>{confirm.user.email ?? confirm.user.username}</strong><br />
                  This permanently deletes the account and all their meetings, transcripts,
                  todos, and recordings. This can&apos;t be undone.
                </p>
                <div style={S.dialogActions}>
                  <button style={S.btn} onClick={() => setConfirm(null)}>Cancel</button>
                  <button style={S.deleteBtn} disabled={busyId === confirm.user.id} onClick={() => { void deleteUser(confirm.user) }}>
                    Delete permanently
                  </button>
                </div>
              </>
            ) : confirm.type === 'reset-password' ? (
              <>
                <h3 style={S.dialogTitle}>Send password reset?</h3>
                <p style={S.dialogBody}>
                  A password-recovery email will be sent to <strong>{confirm.user.email}</strong>.
                  The user will choose a new password via the link in that email.
                </p>
                <div style={S.dialogActions}>
                  <button style={S.btn} onClick={() => setConfirm(null)}>Cancel</button>
                  <button style={S.primaryBtn} disabled={busyId === confirm.user.id} onClick={() => { void sendPasswordReset(confirm.user) }}>
                    Send reset email
                  </button>
                </div>
              </>
            ) : confirm.type === 'role' ? (
              <>
                <h3 style={S.dialogTitle}>{confirm.newRole === 'admin' ? 'Make this user an admin?' : 'Make this user a regular user?'}</h3>
                <p style={S.dialogBody}>
                  <strong>{confirm.user.email ?? confirm.user.username}</strong> will become{' '}
                  <strong>{confirm.newRole === 'admin' ? 'an admin' : 'a regular user'}</strong>.
                  {confirm.newRole === 'admin' && (
                    <><br /><span style={{ color: '#b45309' }}>Warning: this grants full admin access.</span></>
                  )}
                  <br />The change takes effect on their next token refresh.
                </p>
                <div style={S.dialogActions}>
                  <button style={S.btn} onClick={() => setConfirm(null)}>Cancel</button>
                  <button style={S.primaryBtn} disabled={busyId === confirm.user.id} onClick={() => { void changeRole(confirm.user, confirm.newRole) }}>
                    {confirm.newRole === 'admin' ? 'Make admin' : 'Make user'}
                  </button>
                </div>
              </>
            ) : confirm.type === 'status' ? (
              <>
                <h3 style={S.dialogTitle}>{confirm.newDisabled ? 'Disable this account?' : 'Enable this account?'}</h3>
                <p style={S.dialogBody}>
                  <strong>{confirm.user.email ?? confirm.user.username}</strong>{' '}
                  {confirm.newDisabled
                    ? 'will be signed out and blocked from signing in until re-enabled.'
                    : 'will be able to sign in again.'}
                </p>
                <div style={S.dialogActions}>
                  <button style={S.btn} onClick={() => setConfirm(null)}>Cancel</button>
                  <button
                    style={confirm.newDisabled ? S.deleteBtn : S.primaryBtn}
                    disabled={busyId === confirm.user.id}
                    onClick={() => { void setDisabled(confirm.user, confirm.newDisabled) }}
                  >
                    {confirm.newDisabled ? 'Disable account' : 'Enable account'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 style={S.dialogTitle}>Confirm bulk action</h3>
                <p style={S.dialogBody}>
                  Apply <strong>{confirm.action}{confirm.role ? ` → ${confirm.role}` : ''}</strong> to{' '}
                  <strong>{confirm.count} user{confirm.count > 1 ? 's' : ''}</strong>?
                  {confirm.action === 'set_role' && confirm.role === 'admin' && (
                    <><br /><span style={{ color: '#b45309' }}>Warning: this grants admin access.</span></>
                  )}
                </p>
                <div style={S.dialogActions}>
                  <button style={S.btn} onClick={() => setConfirm(null)}>Cancel</button>
                  <button style={S.primaryBtn} disabled={bulkBusy} onClick={() => { void executeBulk(confirm.action, confirm.role) }}>
                    {bulkBusy ? 'Working…' : 'Confirm'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 10_000)    return `${(n / 1_000).toFixed(0)}k`
  return n.toLocaleString('en-US')
}

function formatDuration(seconds: number): string {
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

function menuItemDisable(disabled: boolean): CSSProperties {
  return disabled ? { ...S.menuItem, color: '#bbb', cursor: 'not-allowed' } : S.menuItem
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const S: Record<string, CSSProperties> = {
  page: { padding: '28px 32px', maxWidth: 1180 },
  pageHeader: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 },
  h1: { margin: 0, fontSize: 20, fontWeight: 700, color: '#0f172a' },
  adminBadge: {
    fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
    background: '#fee2e2', color: '#991b1b', padding: '3px 8px', borderRadius: 99,
  },
  muted: { color: '#888', fontSize: 13 },
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
  dismissBtn: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: 'inherit', opacity: 0.6, padding: '0 2px' },
  toolbar: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' },
  searchInput: {
    flex: 1, maxWidth: 280, fontSize: 13, padding: '6px 10px',
    border: '1px solid #d0d0d0', borderRadius: 6, outline: 'none',
  },
  filterSelect: {
    fontSize: 13, padding: '6px 10px', border: '1px solid #d0d0d0',
    borderRadius: 6, background: '#fff', cursor: 'pointer', outline: 'none',
  },
  divider: { width: 1, alignSelf: 'stretch', background: '#e2e8f0', margin: '0 2px' },
  usageLabel: { fontSize: 12, fontWeight: 600, color: '#475569' },
  countLabel: { fontSize: 13, color: '#888', marginLeft: 4 },
  bulkBar: {
    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
    background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8,
    padding: '8px 14px', marginBottom: 10,
  },
  bulkCount: { fontSize: 13, fontWeight: 600, color: '#1d4ed8', marginRight: 4 },
  bulkBtn: {
    fontSize: 12, padding: '4px 12px', border: '1px solid #d0d0d0',
    borderRadius: 5, background: '#fff', cursor: 'pointer', color: '#333', fontWeight: 500,
  },
  tableWrap: { overflowX: 'auto', background: '#fff', borderRadius: 8, border: '1px solid #e2e8f0' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: {
    textAlign: 'left', padding: '10px 12px', fontWeight: 600, whiteSpace: 'nowrap',
    background: '#f8fafc', borderBottom: '1px solid #e2e8f0', color: '#475569', fontSize: 12,
  },
  td: { padding: '10px 12px', borderBottom: '1px solid #f1f5f9', verticalAlign: 'middle' },
  userLink: {
    display: 'flex', flexDirection: 'column', gap: 1, textDecoration: 'none',
    color: 'inherit', cursor: 'pointer', borderRadius: 6, margin: '-4px -6px', padding: '4px 6px',
  },
  disabledRow: { background: '#fcfcfd', color: '#94a3b8' },
  selectedRow: { background: '#eff6ff' },
  youBadge: {
    display: 'inline-block', marginLeft: 6, fontSize: 10, fontWeight: 700,
    background: '#dbeafe', color: '#1d4ed8', padding: '1px 6px', borderRadius: 99,
    textTransform: 'uppercase', letterSpacing: '0.04em',
  },
  roleAdmin: { display: 'inline-block', fontSize: 11, fontWeight: 700, background: '#dbeafe', color: '#1d4ed8', padding: '2px 7px', borderRadius: 99 },
  roleUser:  { display: 'inline-block', fontSize: 11, fontWeight: 600, background: '#f0f0f0', color: '#555', padding: '2px 7px', borderRadius: 99 },
  statusStack: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 },
  badgeActive:     { fontSize: 11, fontWeight: 600, background: '#dcfce7', color: '#166534', padding: '2px 7px', borderRadius: 99 },
  badgeDisabled:   { fontSize: 11, fontWeight: 700, background: '#fee2e2', color: '#991b1b', padding: '2px 7px', borderRadius: 99 },
  badgeVerified:   { fontSize: 10.5, fontWeight: 600, color: '#15803d' },
  badgeUnverified: { fontSize: 10.5, fontWeight: 600, color: '#b45309' },
  kebabBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 30, height: 30, border: '1px solid transparent', borderRadius: 7,
    background: 'transparent', cursor: 'pointer', color: '#475569',
  },
  menuOverlay: { position: 'fixed', inset: 0, zIndex: 90, background: 'transparent' },
  menu: {
    position: 'fixed', width: MENU_WIDTH, background: '#fff', border: '1px solid #e2e8f0',
    borderRadius: 10, boxShadow: '0 12px 32px rgba(15,23,42,0.16)', padding: 6, zIndex: 91,
    display: 'flex', flexDirection: 'column',
  },
  menuItem: {
    display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px',
    border: 'none', background: 'transparent', borderRadius: 6, cursor: 'pointer',
    fontSize: 13, fontWeight: 500, color: '#1f2937', textDecoration: 'none', fontFamily: 'inherit',
  },
  menuSep: { height: 1, background: '#f0f0f4', margin: '4px 6px' },
  pagination: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, justifyContent: 'center' },
  pageBtn: { fontSize: 13, padding: '5px 14px', border: '1px solid #d0d0d0', borderRadius: 6, background: '#fff', cursor: 'pointer', color: '#333' },
  pageLabel: { fontSize: 13, color: '#555' },
  btn: {
    fontSize: 13, padding: '7px 14px', border: '1px solid #d0d0d0',
    borderRadius: 6, background: '#fff', cursor: 'pointer', color: '#333', whiteSpace: 'nowrap',
  },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  dialog: { background: '#fff', borderRadius: 10, padding: '24px 28px', maxWidth: 430, width: '90%', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' },
  dialogTitle: { margin: '0 0 12px', fontSize: 17, fontWeight: 700, color: '#111' },
  dialogBody: { margin: '0 0 20px', fontSize: 14, color: '#444', lineHeight: 1.6 },
  dialogActions: { display: 'flex', gap: 8, justifyContent: 'flex-end' },
  deleteBtn: { fontSize: 13, padding: '7px 16px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 },
  primaryBtn: { fontSize: 13, padding: '7px 16px', background: '#1a7f37', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 },
}
