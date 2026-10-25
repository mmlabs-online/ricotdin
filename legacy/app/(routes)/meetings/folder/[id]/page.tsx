'use client'

import type { CSSProperties, KeyboardEvent } from 'react'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { browserClient } from '@/lib/supabase/browser'
import { getAccessToken } from '@/lib/supabase/auth'
import { getMeetingRole, canPin, canEdit, canDelete } from '@/lib/access/roles'
import type { Meeting, MeetingStatus, FolderWithRole, FolderShareMember, Citation } from '@/types/database'
import ChatPanel from '@/components/ChatPanel'

type LoadState = 'loading' | 'ready' | 'error'

const POLL_INTERVAL_MS = 3_000
const IN_FLIGHT: MeetingStatus[] = ['pending', 'processing']

function sortMeetings(list: Meeting[]): Meeting[] {
  return [...list].sort((a, b) => {
    if (a.pinned_at && b.pinned_at) {
      return new Date(b.pinned_at).getTime() - new Date(a.pinned_at).getTime()
    }
    if (a.pinned_at) return -1
    if (b.pinned_at) return 1
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

export default function FolderMeetingsPage() {
  const params   = useParams()
  const router   = useRouter()
  const folderId = params.id as string

  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  // undefined = folder fetch not finished yet; null = fetched but not found
  const [folder, setFolder] = useState<FolderWithRole | null | undefined>(undefined)
  const [allFolders, setAllFolders] = useState<FolderWithRole[]>([])
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionWarning, setActionWarning] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [movingMeetingId, setMovingMeetingId] = useState<string | null>(null)
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)

  // share panel (for folder share from this page)
  const [sharingOpen, setSharingOpen] = useState(false)
  const [shareMembers, setShareMembers] = useState<FolderShareMember[]>([])
  const [shareBusy, setShareBusy] = useState(false)
  const [shareError, setShareError] = useState<string | null>(null)
  const [addShareIdentifier, setAddShareIdentifier] = useState('')
  const [addShareRole, setAddShareRole] = useState<'editor' | 'viewer'>('viewer')
  const [addShareBusy, setAddShareBusy] = useState(false)
  const [addShareError, setAddShareError] = useState<string | null>(null)

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── load current user ──────────────────────────────────────────────────────
  useEffect(() => {
    browserClient.auth.getUser().then(({ data }) => {
      setCurrentUserId(data.user?.id ?? null)
    })
  }, [])

  // ── load folder info (once per folderId; not polled) ───────────────────────
  useEffect(() => {
    let cancelled = false

    async function loadFolders() {
      const token = await getAccessToken()
      if (!token || cancelled) return
      const res = await fetch('/api/folders', { headers: { Authorization: `Bearer ${token}` } })
      if (cancelled) return
      if (!res.ok) { setFolder(null); return }
      const json = (await res.json()) as { folders: FolderWithRole[] }
      if (cancelled) return
      setAllFolders(json.folders)
      setFolder(json.folders.find((f) => f.id === folderId) ?? null)
    }

    void loadFolders()
    return () => { cancelled = true }
  }, [folderId])

  // ── load meetings + poll while any are in-flight ───────────────────────────
  useEffect(() => {
    let cancelled = false

    async function load(silent = false) {
      try {
        const { data, error } = await browserClient
          .from('meetings')
          .select('*')
          .eq('folder_id', folderId)
          .order('created_at', { ascending: false })

        if (cancelled) return
        if (error) throw new Error(error.message)
        const rows = sortMeetings((data as Meeting[]) ?? [])
        setMeetings(rows)
        if (!silent) setLoadState('ready')

        if (rows.some((m) => IN_FLIGHT.includes(m.status))) {
          pollRef.current = setTimeout(() => void load(true), POLL_INTERVAL_MS)
        }
      } catch (err) {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : 'Failed to load meetings.')
        setLoadState('error')
      }
    }

    void load()
    return () => {
      cancelled = true
      if (pollRef.current) clearTimeout(pollRef.current)
    }
  }, [folderId])

  // ── meeting actions ────────────────────────────────────────────────────────
  async function togglePin(m: Meeting) {
    const token = await getAccessToken()
    if (!token) return
    setActionError(null)
    setBusyId(m.id)

    const newPinnedAt = m.pinned_at ? null : new Date().toISOString()
    setMeetings((prev) => sortMeetings(prev.map((x) => x.id === m.id ? { ...x, pinned_at: newPinnedAt } : x)))

    try {
      const res = await fetch(`/api/meetings/${m.id}/pin`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = (await res.json()) as { pinned_at?: string | null; error?: string }
      if (!res.ok) {
        setMeetings((prev) => sortMeetings(prev.map((x) => x.id === m.id ? { ...x, pinned_at: m.pinned_at } : x)))
        setActionError(data.error ?? 'Failed to update pin.')
      } else {
        setMeetings((prev) => sortMeetings(prev.map((x) =>
          x.id === m.id ? { ...x, pinned_at: data.pinned_at ?? null } : x,
        )))
      }
    } catch {
      setMeetings((prev) => sortMeetings(prev.map((x) => x.id === m.id ? { ...x, pinned_at: m.pinned_at } : x)))
      setActionError('Network error — please try again.')
    } finally {
      setBusyId(null)
    }
  }

  function startRename(m: Meeting) {
    setEditingId(m.id)
    setEditTitle(m.title)
    setActionError(null)
  }

  async function saveRename(meetingId: string) {
    const trimmed = editTitle.trim()
    if (!trimmed) { setActionError('Title must not be empty.'); return }

    const token = await getAccessToken()
    if (!token) return
    setActionError(null)
    setBusyId(meetingId)

    const prevTitle = meetings.find((m) => m.id === meetingId)?.title ?? ''
    setMeetings((prev) => prev.map((x) => x.id === meetingId ? { ...x, title: trimmed } : x))
    setEditingId(null)

    try {
      const res = await fetch(`/api/meetings/${meetingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: trimmed }),
      })
      const data = (await res.json()) as { error?: string }
      if (!res.ok) {
        setMeetings((prev) => prev.map((x) => x.id === meetingId ? { ...x, title: prevTitle } : x))
        setActionError(data.error ?? 'Failed to rename meeting.')
      }
    } catch {
      setMeetings((prev) => prev.map((x) => x.id === meetingId ? { ...x, title: prevTitle } : x))
      setActionError('Network error — please try again.')
    } finally {
      setBusyId(null)
    }
  }

  async function deleteMeeting(meetingId: string) {
    const token = await getAccessToken()
    if (!token) return
    setActionError(null)
    setActionWarning(null)
    setBusyId(meetingId)
    setConfirmDeleteId(null)

    try {
      const res = await fetch(`/api/meetings/${meetingId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = (await res.json()) as { ok?: boolean; warning?: string; error?: string }
      if (!res.ok) {
        setActionError(data.error ?? 'Failed to delete meeting.')
      } else {
        setMeetings((prev) => prev.filter((x) => x.id !== meetingId))
        if (data.warning) setActionWarning(data.warning)
      }
    } catch {
      setActionError('Network error — please try again.')
    } finally {
      setBusyId(null)
    }
  }

  async function moveMeeting(meetingId: string, newFolderId: string | null) {
    setMovingMeetingId(null)
    const token = await getAccessToken()
    if (!token) return
    setActionError(null)

    try {
      const res = await fetch(`/api/meetings/${meetingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ folder_id: newFolderId }),
      })
      const data = (await res.json()) as { error?: string }
      if (!res.ok) {
        setActionError(data.error ?? 'Failed to move meeting.')
      } else {
        // Remove from this folder view — meeting moved elsewhere
        setMeetings((prev) => prev.filter((x) => x.id !== meetingId))
      }
    } catch {
      setActionError('Network error — please try again.')
    }
  }

  // ── share panel ────────────────────────────────────────────────────────────
  async function openSharePanel() {
    setSharingOpen(true)
    setShareMembers([])
    setShareError(null)
    setAddShareIdentifier('')
    setAddShareError(null)
    setShareBusy(true)

    const token = await getAccessToken()
    if (!token) { setShareBusy(false); return }

    try {
      const res = await fetch(`/api/folders/${folderId}/shares`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = (await res.json()) as { members?: FolderShareMember[]; error?: string }
      if (!res.ok) {
        setShareError(data.error ?? 'Failed to load members.')
      } else {
        setShareMembers(data.members ?? [])
      }
    } catch {
      setShareError('Network error — please try again.')
    } finally {
      setShareBusy(false)
    }
  }

  async function addShareMember() {
    const identifier = addShareIdentifier.trim()
    if (!identifier) return
    const token = await getAccessToken()
    if (!token) return
    setAddShareBusy(true)
    setAddShareError(null)

    try {
      const res = await fetch(`/api/folders/${folderId}/shares`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ identifier, role: addShareRole }),
      })
      const data = (await res.json()) as { member?: FolderShareMember; error?: string }
      if (!res.ok) {
        setAddShareError(data.error ?? 'Failed to add member.')
      } else if (data.member) {
        setShareMembers((prev) => [...prev, data.member!])
        setAddShareIdentifier('')
        setFolder((f) => f ? { ...f, memberCount: f.memberCount + 1 } : f)
      }
    } catch {
      setAddShareError('Network error — please try again.')
    } finally {
      setAddShareBusy(false)
    }
  }

  async function changeShareRole(userId: string, newRole: 'editor' | 'viewer') {
    const token = await getAccessToken()
    if (!token) return
    const prev = shareMembers
    setShareMembers((m) => m.map((x) => x.userId === userId ? { ...x, role: newRole } : x))

    try {
      const res = await fetch(`/api/folders/${folderId}/shares/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ role: newRole }),
      })
      if (!res.ok) { setShareMembers(prev); setShareError('Failed to change role.') }
    } catch {
      setShareMembers(prev)
      setShareError('Network error — please try again.')
    }
  }

  async function removeMember(granteeId: string) {
    const token = await getAccessToken()
    if (!token) return
    const prev = shareMembers
    setShareMembers((m) => m.filter((x) => x.userId !== granteeId))
    setFolder((f) => f ? { ...f, memberCount: Math.max(0, f.memberCount - 1) } : f)

    try {
      const res = await fetch(`/api/folders/${folderId}/shares/${granteeId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        setShareMembers(prev)
        setFolder((f) => f ? { ...f, memberCount: f.memberCount + 1 } : f)
        setShareError('Failed to remove member.')
      }
    } catch {
      setShareMembers(prev)
      setFolder((f) => f ? { ...f, memberCount: f.memberCount + 1 } : f)
      setShareError('Network error — please try again.')
    }
  }

  // ── citation click: navigate to the meeting at the cited timestamp ────────
  function handleCitationClick(c: Citation) {
    const t = Math.floor(c.start_ms / 1000)
    router.push(`/meetings/${c.meeting_id}?t=${t}`)
  }

  // ── derived ────────────────────────────────────────────────────────────────
  const confirmTarget   = confirmDeleteId ? meetings.find((m) => m.id === confirmDeleteId) : null
  const editableFolders = allFolders.filter((f) => f.myRole === 'owner' || f.myRole === 'editor')
  const folderAsArray: FolderWithRole[] = folder ? [folder] : []
  const isOwned  = folder?.myRole === 'owner'
  const isShared = isOwned ? (folder?.memberCount ?? 0) > 0 : true

  // meetingTitles map for cross-meeting citation labels in ChatPanel
  const meetingTitles: Record<string, string> = Object.fromEntries(
    meetings.map((m) => [m.id, m.title]),
  )

// ── Theme-aware constants ─────────────────────────────────────────────────────
const T = {
  bg:       'rgb(var(--t-bg-rgb))',
  fg:       'rgb(var(--t-fg-rgb))',
  primary:  'rgb(var(--t-primary-rgb))',
  secondary:'rgb(var(--t-secondary-rgb))',
  border:   'rgb(var(--t-border-rgb))',
  clay:     'rgb(var(--t-clay-rgb))',
  fgMuted:  'rgb(var(--t-fg-rgb) / 0.5)',
  fgSubtle: 'rgb(var(--t-fg-rgb) / 0.35)',
  font:     'var(--t-font-body)',
  radius:   'var(--t-radius-card)',
}

  // ── inner helpers ──────────────────────────────────────────────────────────
  function KebabDots() {
    return (
      <>
        <span style={{ width: 3.5, height: 3.5, borderRadius: '50%', background: T.fgMuted, display: 'block' }} />
        <span style={{ width: 3.5, height: 3.5, borderRadius: '50%', background: T.fgMuted, display: 'block' }} />
        <span style={{ width: 3.5, height: 3.5, borderRadius: '50%', background: T.fgMuted, display: 'block' }} />
      </>
    )
  }

  function renderMeeting(m: Meeting) {
    const isMoving = movingMeetingId === m.id
    const myRole = currentUserId
      ? getMeetingRole({ user_id: m.user_id, folder_id: m.folder_id }, currentUserId, folderAsArray)
      : 'viewer'
    const canPinThis    = currentUserId ? canPin({ user_id: m.user_id }, currentUserId) : false
    const canEditThis   = canEdit(myRole)
    const canDeleteThis = canDelete(myRole)

    const statusStyle: Record<string, { color: string; bg: string }> = {
      done:       { color: '#059669', bg: 'rgb(209 250 229)' },
      pending:    { color: T.fgMuted, bg: T.clay },
      processing: { color: T.primary, bg: `${T.primary}15` },
      failed:     { color: 'rgb(220 38 38)', bg: 'rgb(254 226 226)' },
    }
    const ss = statusStyle[m.status] ?? statusStyle.pending

    const menuItemBase: CSSProperties = {
      width: '100%', textAlign: 'left', padding: '9px 12px', border: 'none',
      background: 'transparent', borderRadius: 8, cursor: 'pointer',
      fontFamily: T.font, fontSize: 13, fontWeight: 600, color: T.fg,
      display: 'flex', alignItems: 'center', gap: 9,
    }

    return (
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 14,
        background: 'white',
        border: `1px solid ${m.pinned_at ? T.primary + '50' : T.border}`,
        borderRadius: T.radius, padding: '14px 16px',
        boxShadow: m.pinned_at ? 'var(--t-shadow-sm)' : undefined,
      }}>
        {/* Play / pin tile */}
        <span style={{
          width: 46, height: 46, flexShrink: 0, borderRadius: 12,
          background: `linear-gradient(135deg, ${T.primary}18, ${T.primary}0a)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {m.pinned_at
            ? <span style={{ fontSize: 18 }}>📌</span>
            : <span style={{ width: 0, height: 0, borderStyle: 'solid', borderWidth: '7px 0 7px 11px', borderColor: `transparent transparent transparent ${T.primary}`, marginLeft: 2 }} />
          }
        </span>

        {/* Content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {editingId === m.id ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                style={{ flex: 1, minWidth: 0, padding: '6px 12px', borderRadius: 'var(--t-radius-input)', border: `1px solid ${T.primary}`, background: T.clay, fontSize: 14, fontWeight: 600, fontFamily: T.font, outline: 'none' }}
                value={editTitle}
                maxLength={200}
                autoFocus
                onChange={(e) => setEditTitle(e.target.value)}
                onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === 'Enter') void saveRename(m.id)
                  if (e.key === 'Escape') setEditingId(null)
                }}
              />
              <button disabled={busyId === m.id} onClick={() => void saveRename(m.id)} style={{ padding: '6px 14px', borderRadius: 999, border: 'none', background: T.primary, color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: T.font, flexShrink: 0 }}>Save</button>
              <button onClick={() => setEditingId(null)} style={{ padding: '6px 14px', borderRadius: 999, border: `1px solid ${T.border}`, background: 'white', color: T.fgSubtle, fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: T.font, flexShrink: 0 }}>Cancel</button>
            </div>
          ) : (
            <Link href={`/meetings/${m.id}`} style={{ textDecoration: 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 14.5, fontWeight: 700, color: T.fg, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.title}
                </span>
                <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.05em', color: ss.color, background: ss.bg, borderRadius: 6, padding: '3px 7px', flexShrink: 0 }}>
                  {m.status.toUpperCase()}
                </span>
              </div>
              <div style={{ fontSize: 12, fontWeight: 500, color: T.fgMuted, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span>{formatDate(m.created_at)}</span>
                {m.duration_seconds != null && (
                  <><span style={{ width: 3, height: 3, borderRadius: '50%', background: T.border, display: 'inline-block' }} /><span>{formatDuration(m.duration_seconds)}</span></>
                )}
                {myRole !== 'owner' && (
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', color: T.fgMuted, background: T.clay, borderRadius: 5, padding: '2px 6px', textTransform: 'uppercase' }}>{myRole}</span>
                )}
              </div>
            </Link>
          )}

          {isMoving && editingId !== m.id && (
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
              <select
                defaultValue={m.folder_id ?? ''}
                onChange={(e) => { const v = e.target.value; void moveMeeting(m.id, v === '' ? null : v) }}
                autoFocus
                style={{ flex: 1, borderRadius: 'var(--t-radius-input)', border: `1px solid ${T.border}`, background: T.clay, padding: '7px 10px', fontSize: 13, fontFamily: T.font, color: T.fg, outline: 'none', cursor: 'pointer' }}
              >
                <option value="">Uncategorized</option>
                {editableFolders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
              <button onClick={() => setMovingMeetingId(null)} style={{ flexShrink: 0, padding: '7px 14px', borderRadius: 'var(--t-radius-input)', border: `1px solid ${T.border}`, background: 'white', color: T.fgSubtle, fontSize: 12, cursor: 'pointer', fontFamily: T.font }}>Cancel</button>
            </div>
          )}
        </div>

        {/* ⋯ kebab */}
        {editingId !== m.id && !isMoving && (
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button
              onClick={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === m.id ? null : m.id) }}
              style={{ width: 30, height: 30, borderRadius: 9, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2.5 }}
            ><KebabDots /></button>
            {openMenuId === m.id && (
              <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: 160, background: 'white', border: `1px solid ${T.border}`, borderRadius: 12, boxShadow: 'var(--t-shadow-xl)', padding: 6, zIndex: 50 }}>
                <a href={`/meetings/${m.id}`} onClick={() => setOpenMenuId(null)} style={{ ...menuItemBase, textDecoration: 'none' }}><span style={{ color: T.fgMuted }}>▷</span> Open</a>
                {canPinThis && (
                  <button disabled={busyId === m.id} onClick={() => { setOpenMenuId(null); void togglePin(m) }} style={menuItemBase}>
                    <span style={{ color: T.fgMuted }}>📌</span> {m.pinned_at ? 'Unpin' : 'Pin to top'}
                  </button>
                )}
                {canEditThis && (
                  <button disabled={busyId === m.id} onClick={() => { setOpenMenuId(null); startRename(m) }} style={menuItemBase}><span style={{ color: T.fgMuted }}>✎</span> Rename</button>
                )}
                {canEditThis && (
                  <button disabled={busyId === m.id} onClick={() => { setOpenMenuId(null); setMovingMeetingId(m.id); setActionError(null) }} style={menuItemBase}><span style={{ color: T.fgMuted }}>↗</span> Move to…</button>
                )}
                {canDeleteThis && (
                  <>
                    <div style={{ height: 1, background: T.clay, margin: '4px 6px' }} />
                    <button disabled={busyId === m.id} onClick={() => { setOpenMenuId(null); setConfirmDeleteId(m.id) }} style={{ ...menuItemBase, fontWeight: 700, color: 'rgb(239 68 68)' }}><span>🗑</span> Delete</button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  // ── render ─────────────────────────────────────────────────────────────────
  const iconTileBg = isShared ? `${T.primary}15` : 'rgb(254 243 199)'

  return (
    <div style={{ background: T.bg, minHeight: '100vh', fontFamily: T.font }}>

      {/* Click-away overlay for open kebab menus */}
      {openMenuId && (
        <div onClick={() => setOpenMenuId(null)} style={{ position: 'fixed', inset: 0, zIndex: 20 }} />
      )}

      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '36px 28px 80px' }}>

        {/* ── Header ── */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 36 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <Link
              href="/meetings"
              style={{ display: 'flex', alignItems: 'center', gap: 6, color: T.fgMuted, fontSize: 13, fontWeight: 600, textDecoration: 'none', flexShrink: 0 }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              All meetings
            </Link>
            <span style={{ color: T.border, fontSize: 16 }}>/</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {/* Folder icon tile */}
              <span style={{ width: 44, height: 44, borderRadius: 12, background: iconTileBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {isShared ? (
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                    <circle cx="9" cy="8" r="3.2" fill="#6c5ce7"/>
                    <circle cx="16" cy="9" r="2.6" fill="#a99bf2"/>
                    <path d="M3.5 18c0-2.8 2.4-4.6 5.5-4.6s5.5 1.8 5.5 4.6" stroke="#6c5ce7" strokeWidth="2" strokeLinecap="round"/>
                    <path d="M15 14c2.4.1 4.4 1.5 4.4 4" stroke="#a99bf2" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                ) : (
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l1.7 1.7H19.5A1.5 1.5 0 0 1 21 9.2v8.3A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10Z" fill="#f6c343"/>
                  </svg>
                )}
              </span>
              <div>
                <h1 style={{ fontSize: 24, fontWeight: 800, color: T.fg, letterSpacing: '-0.01em', margin: 0, fontFamily: 'var(--t-font-heading)' }}>
                  {loadState === 'loading' ? '…' : (folder?.name ?? 'Folder')}
                </h1>
                {loadState === 'ready' && (
                  <p style={{ fontSize: 12, color: T.fgMuted, fontWeight: 500, margin: '2px 0 0' }}>
                    {meetings.length} meeting{meetings.length !== 1 ? 's' : ''}
                    {isOwned && (folder?.memberCount ?? 0) > 0 && ` · shared with ${folder!.memberCount} ${folder!.memberCount === 1 ? 'person' : 'people'}`}
                    {!isOwned && folder && ` · shared by @${folder.ownerUsername ?? '?'} · ${folder.myRole}`}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Header actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            {isOwned && (
              <button
                onClick={() => void openSharePanel()}
                style={{ padding: '9px 18px', borderRadius: 999, border: `1.5px solid ${T.border}`, background: 'white', color: T.fg, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: T.font, display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="9" cy="7" r="3" stroke="#6c5ce7" strokeWidth="2"/><path d="M3 20c0-3.3 2.7-6 6-6" stroke="#6c5ce7" strokeWidth="2" strokeLinecap="round"/><path d="M16 11a5 5 0 0 1 5 5M19 13l2 3-3 1" stroke="#9a9bab" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Share
              </button>
            )}
            <Link
              href={`/record?folder=${folderId}`}
              style={{ padding: '9px 18px', borderRadius: 999, border: 'none', background: T.primary, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: T.font, textDecoration: 'none', display: 'inline-block' }}
            >
              + New recording
            </Link>
          </div>
        </div>

        {/* ── Banners ── */}
        {actionError && (
          <div className="banner-error">
            <span>{actionError}</span>
            <button onClick={() => setActionError(null)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 16, opacity: 0.6 }}>✕</button>
          </div>
        )}
        {actionWarning && (
          <div className="banner-warning">
            <span>{actionWarning}</span>
            <button onClick={() => setActionWarning(null)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 16, opacity: 0.6 }}>✕</button>
          </div>
        )}

        {/* ── Loading ── */}
        {loadState === 'loading' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[1, 2, 3].map((i) => (
              <div key={i} style={{ height: 76, borderRadius: T.radius, background: T.border, opacity: 0.7, animationDelay: `${i * 100}ms` }} />
            ))}
          </div>
        )}

        {/* ── Error ── */}
        {loadState === 'error' && (
          <div className="banner-error">{loadError}</div>
        )}

        {/* ── Folder not found ── */}
        {loadState === 'ready' && folder === null && (
          <div style={{ textAlign: 'center', padding: '80px 0' }}>
            <p style={{ fontSize: 18, fontWeight: 700, color: T.fg, marginBottom: 8, fontFamily: 'var(--t-font-heading)' }}>Folder not found</p>
            <p style={{ fontSize: 14, color: T.fgMuted, marginBottom: 24 }}>This folder may have been deleted or you don&apos;t have access.</p>
            <Link href="/meetings" style={{ padding: '10px 22px', borderRadius: 999, border: 'none', background: T.primary, color: '#fff', fontSize: 14, fontWeight: 700, textDecoration: 'none', display: 'inline-block' }}>
              Back to meetings
            </Link>
          </div>
        )}

        {/* ── Meeting list + chat panel ──
            Gated on the STABLE `folder` (loaded once), never on the polled
            `meetings` state — so the 3s meetings poll re-renders the list
            without ever remounting <ChatPanel> (which would re-fetch history
            on every tick). `key={folderId}` pins the panel instance to the
            scope: it remounts only when navigating to a different folder. */}
        {loadState === 'ready' && folder && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr minmax(300px, 360px)', gap: 28, alignItems: 'start' }}>
            {/* Meeting list (or empty state) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {meetings.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '80px 0' }}>
                  <div style={{ width: 56, height: 56, borderRadius: 16, background: iconTileBg, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px', fontSize: 26 }}>
                    {isShared ? '👥' : '📁'}
                  </div>
                  <p style={{ fontSize: 18, fontWeight: 700, color: T.fg, marginBottom: 8, fontFamily: 'var(--t-font-heading)' }}>No meetings in this folder</p>
                  <p style={{ fontSize: 14, color: T.fgMuted, marginBottom: 24 }}>Record a meeting and move it here.</p>
                  <Link href={`/record?folder=${folderId}`} style={{ padding: '10px 22px', borderRadius: 999, border: 'none', background: T.primary, color: '#fff', fontSize: 14, fontWeight: 700, textDecoration: 'none', display: 'inline-block' }}>
                    + New recording
                  </Link>
                </div>
              ) : (
                meetings.map((m) => <div key={m.id}>{renderMeeting(m)}</div>)
              )}
            </div>

            {/* Folder chat panel */}
            <div style={{
              position: 'sticky', top: 24,
              border: `1px solid ${T.border}`, borderRadius: T.radius,
              background: 'white', padding: 20,
              boxShadow: 'var(--t-shadow-sm)',
            }}>
              <p style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', color: T.fgMuted, textTransform: 'uppercase', marginBottom: 12 }}>
                Folder chat
              </p>
              <ChatPanel
                key={folderId}
                folderId={folderId}
                folderName={folder.name}
                meetingTitles={meetingTitles}
                onCitationClick={handleCitationClick}
                height={520}
              />
            </div>
          </div>
        )}

      </div>

      {/* ── Delete meeting confirmation ── */}
      {confirmTarget && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(20,22,40,0.4)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 }}
          onClick={() => setConfirmDeleteId(null)}
        >
          <div
            style={{ background: 'white', borderRadius: T.radius, border: `1px solid ${T.border}`, boxShadow: 'var(--t-shadow-xl)', padding: 32, maxWidth: 420, width: '100%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ fontSize: 20, fontWeight: 800, color: T.fg, marginBottom: 12, fontFamily: 'var(--t-font-heading)' }}>Delete this meeting?</h3>
            <p style={{ fontSize: 14, color: T.fgMuted, lineHeight: 1.6, marginBottom: 24 }}>
              <strong style={{ color: T.fg }}>&ldquo;{confirmTarget.title}&rdquo;</strong>
              <br />
              This permanently deletes the meeting, transcript, todos, and recording. This can&apos;t be undone.
            </p>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmDeleteId(null)} style={{ padding: '10px 20px', borderRadius: 999, border: `1.5px solid ${T.border}`, background: 'white', color: T.fgSubtle, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: T.font }}>Cancel</button>
              <button
                disabled={busyId === confirmTarget.id}
                onClick={() => void deleteMeeting(confirmTarget.id)}
                style={{ padding: '10px 20px', borderRadius: 999, border: 'none', background: 'rgb(239 68 68)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: T.font, opacity: busyId === confirmTarget.id ? 0.65 : 1 }}
              >
                Delete permanently
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Share panel modal ── */}
      {sharingOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(20,22,40,0.4)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 }}
          onClick={() => { setSharingOpen(false); setShareError(null) }}
        >
          <div
            style={{ background: 'white', borderRadius: T.radius, border: `1px solid ${T.border}`, boxShadow: 'var(--t-shadow-xl)', padding: 32, maxWidth: 440, width: '100%', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <h3 style={{ fontSize: 18, fontWeight: 800, color: T.fg, margin: 0, fontFamily: 'var(--t-font-heading)' }}>Share &ldquo;{folder?.name}&rdquo;</h3>
              <button onClick={() => { setSharingOpen(false); setShareError(null) }} style={{ background: 'none', border: 'none', color: T.fgMuted, cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>✕</button>
            </div>

            {shareError && <p style={{ fontSize: 12, color: 'rgb(239 68 68)', marginBottom: 10 }}>{shareError}</p>}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', flex: 1, minHeight: 0, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 12, background: T.clay }}>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: T.fg }}>You</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: T.fgMuted, background: T.clay, borderRadius: 6, padding: '2px 8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Owner</span>
              </div>
              {shareBusy && <p style={{ fontSize: 12, color: T.fgMuted, textAlign: 'center', padding: '8px 0' }}>Loading members…</p>}
              {!shareBusy && shareMembers.map((member) => (
                <div key={member.userId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 12, border: `1px solid ${T.border}` }}>
                  <span style={{ flex: 1, fontSize: 13, color: T.fg, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>@{member.username}</span>
                  <select value={member.role} onChange={(e) => void changeShareRole(member.userId, e.target.value as 'editor' | 'viewer')} style={{ fontSize: 12, border: `1px solid ${T.border}`, borderRadius: 8, padding: '3px 6px', background: 'white', color: T.fg, cursor: 'pointer', fontFamily: T.font }}>
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                  </select>
                  <button onClick={() => void removeMember(member.userId)} style={{ fontSize: 12, color: 'rgb(239 68 68)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: T.font, padding: '2px 6px' }}>Remove</button>
                </div>
              ))}
              {!shareBusy && shareMembers.length === 0 && (
                <p style={{ fontSize: 12, color: T.fgMuted, textAlign: 'center', padding: '8px 0' }}>No members yet — add someone below.</p>
              )}
            </div>

            <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 16 }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: T.fgMuted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Add member</p>
              <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                <input
                  type="text"
                  value={addShareIdentifier}
                  onChange={(e) => setAddShareIdentifier(e.target.value)}
                  placeholder="Email or @username"
                  disabled={addShareBusy}
                  onKeyDown={(e) => { if (e.key === 'Enter') void addShareMember() }}
                  style={{ flex: 1, minWidth: 0, padding: '8px 12px', borderRadius: 'var(--t-radius-input)', border: `1px solid ${T.border}`, background: T.clay, fontSize: 13, fontFamily: T.font, color: T.fg, outline: 'none' }}
                />
                <select value={addShareRole} onChange={(e) => setAddShareRole(e.target.value as 'editor' | 'viewer')} style={{ fontSize: 13, border: `1px solid ${T.border}`, borderRadius: 'var(--t-radius-input)', padding: '8px 10px', background: T.clay, color: T.fg, cursor: 'pointer', fontFamily: T.font, flexShrink: 0 }}>
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                </select>
                <button onClick={() => void addShareMember()} disabled={!addShareIdentifier.trim() || addShareBusy} style={{ flexShrink: 0, padding: '8px 16px', borderRadius: 'var(--t-radius-input)', border: 'none', background: T.primary, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: T.font, opacity: !addShareIdentifier.trim() || addShareBusy ? 0.5 : 1 }}>Add</button>
              </div>
              {addShareError && <p style={{ fontSize: 12, color: 'rgb(239 68 68)' }}>{addShareError}</p>}
              <p style={{ fontSize: 11, color: T.fgMuted, margin: '4px 0 0' }}>Viewer: read-only · Editor: can rename and delete meetings</p>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
