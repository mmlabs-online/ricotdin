'use client'

import type { CSSProperties, DragEvent, KeyboardEvent } from 'react'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { browserClient } from '@/lib/supabase/browser'
import { getAccessToken } from '@/lib/supabase/auth'
import { getMeetingRole, canPin, canEdit, canDelete, canManageShares } from '@/lib/access/roles'
import { folderDeleteChatNotice, folderDeleteCounts } from '@/lib/folders/deleteNotice'
import type { Meeting, MeetingStatus, FolderWithRole, FolderShareMember } from '@/types/database'

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

export default function MeetingsPage() {
  // ── meeting list state ─────────────────────────────────────────────────────
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [loadState, setLoadState]     = useState<LoadState>('loading')
  const [meetings, setMeetings]       = useState<Meeting[]>([])
  const [loadError, setLoadError]     = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionWarning, setActionWarning] = useState<string | null>(null)
  const [busyId, setBusyId]           = useState<string | null>(null)
  const [editingId, setEditingId]     = useState<string | null>(null)
  const [editTitle, setEditTitle]     = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── folder state ───────────────────────────────────────────────────────────
  const [folders, setFolders]           = useState<FolderWithRole[]>([])
  const [foldersLoading, setFoldersLoading] = useState(true)
  const [manageFoldersOpen, setManageFoldersOpen]   = useState(false)
  const [newFolderName, setNewFolderName]   = useState('')
  const [newFolderError, setNewFolderError] = useState<string | null>(null)
  const [newFolderBusy, setNewFolderBusy]   = useState(false)
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
  const [renameFolderTitle, setRenameFolderTitle] = useState('')
  const [renameFolderError, setRenameFolderError] = useState<string | null>(null)
  const [folderBusy, setFolderBusy] = useState<string | null>(null)
  const [confirmDeleteFolderId, setConfirmDeleteFolderId] = useState<string | null>(null)
  const [movingMeetingId, setMovingMeetingId] = useState<string | null>(null)
  const [dragFromIndex, setDragFromIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  // ── share panel state ──────────────────────────────────────────────────────
  const [sharingFolderId, setSharingFolderId]     = useState<string | null>(null)
  const [shareMembers, setShareMembers]           = useState<FolderShareMember[]>([])
  const [shareBusy, setShareBusy]                 = useState(false)
  const [shareError, setShareError]               = useState<string | null>(null)
  const [addShareIdentifier, setAddShareIdentifier] = useState('')
  const [addShareRole, setAddShareRole]           = useState<'editor' | 'viewer'>('viewer')
  const [addShareBusy, setAddShareBusy]           = useState(false)
  const [addShareError, setAddShareError]         = useState<string | null>(null)

  // ── kebab menu state ───────────────────────────────────────────────────────
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)

  // ── load current user ──────────────────────────────────────────────────────
  useEffect(() => {
    browserClient.auth.getUser().then(({ data }) => {
      setCurrentUserId(data.user?.id ?? null)
    })
  }, [])

  // ── load meetings ──────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    async function load(silent = false) {
      try {
        const { data, error: dbError } = await browserClient
          .from('meetings')
          .select('*')
          .order('created_at', { ascending: false })

        if (cancelled) return
        if (dbError) throw new Error(dbError.message)
        const rows = sortMeetings((data as Meeting[]) ?? [])
        setMeetings(rows)
        if (!silent) setLoadState('ready')

        if (rows.some((m) => IN_FLIGHT.includes(m.status))) {
          pollRef.current = setTimeout(() => { void load(true) }, POLL_INTERVAL_MS)
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
  }, [])

  // ── load folders (owned + shared) ─────────────────────────────────────────
  useEffect(() => {
    async function loadFolders() {
      const token = await getAccessToken()
      if (!token) { setFoldersLoading(false); return }
      try {
        const res = await fetch('/api/folders', { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) return
        const json = (await res.json()) as { folders: FolderWithRole[] }
        setFolders(json.folders)
      } catch { /* non-fatal */ }
      finally { setFoldersLoading(false) }
    }
    void loadFolders()
  }, [])

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
    setMovingMeetingId(null)   // close selector immediately
    const token = await getAccessToken()
    if (!token) return
    setActionError(null)

    const prevFolderId = meetings.find((m) => m.id === meetingId)?.folder_id ?? null
    setMeetings((prev) => prev.map((x) => x.id === meetingId ? { ...x, folder_id: newFolderId } : x))

    try {
      const res = await fetch(`/api/meetings/${meetingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ folder_id: newFolderId }),
      })
      const data = (await res.json()) as { error?: string }
      if (!res.ok) {
        setMeetings((prev) => prev.map((x) => x.id === meetingId ? { ...x, folder_id: prevFolderId } : x))
        setActionError(data.error ?? 'Failed to move meeting.')
      }
    } catch {
      setMeetings((prev) => prev.map((x) => x.id === meetingId ? { ...x, folder_id: prevFolderId } : x))
      setActionError('Network error — please try again.')
    }
  }

  // ── folder actions ─────────────────────────────────────────────────────────
  async function createFolder() {
    const name = newFolderName.trim()
    if (!name) return
    const token = await getAccessToken()
    if (!token) return
    setNewFolderBusy(true)
    setNewFolderError(null)

    try {
      const res = await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name }),
      })
      const data = (await res.json()) as { folder?: FolderWithRole; error?: string }
      if (!res.ok) {
        setNewFolderError(data.error ?? 'Failed to create folder.')
      } else if (data.folder) {
        setFolders((prev) => [...prev, data.folder!])
        setNewFolderName('')
      }
    } catch {
      setNewFolderError('Network error — please try again.')
    } finally {
      setNewFolderBusy(false)
    }
  }

  function startRenameFolder(f: FolderWithRole) {
    setRenamingFolderId(f.id)
    setRenameFolderTitle(f.name)
    setRenameFolderError(null)
    setConfirmDeleteFolderId(null)
  }

  async function saveRenameFolder(folderId: string) {
    const name = renameFolderTitle.trim()
    if (!name) { setRenameFolderError('Name must not be empty.'); return }
    const token = await getAccessToken()
    if (!token) return
    setFolderBusy(folderId)
    setRenameFolderError(null)

    const prevName = folders.find((f) => f.id === folderId)?.name ?? ''
    setFolders((prev) => prev.map((f) => f.id === folderId ? { ...f, name } : f))
    setRenamingFolderId(null)

    try {
      const res = await fetch(`/api/folders/${folderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name }),
      })
      const data = (await res.json()) as { folder?: FolderWithRole; error?: string }
      if (!res.ok) {
        setFolders((prev) => prev.map((f) => f.id === folderId ? { ...f, name: prevName } : f))
        setRenameFolderError(data.error ?? 'Failed to rename folder.')
        setRenamingFolderId(folderId)
        setRenameFolderTitle(name)
      } else if (data.folder) {
        setFolders((prev) =>
          prev.map((f) => f.id === folderId ? { ...data.folder!, myRole: f.myRole, ownerUsername: f.ownerUsername } : f)
        )
      }
    } catch {
      setFolders((prev) => prev.map((f) => f.id === folderId ? { ...f, name: prevName } : f))
      setRenameFolderError('Network error — please try again.')
      setRenamingFolderId(folderId)
      setRenameFolderTitle(name)
    } finally {
      setFolderBusy(null)
    }
  }

  async function deleteFolder(folderId: string, deleteMeetings: boolean) {
    const token = await getAccessToken()
    if (!token) return
    setFolderBusy(folderId)
    setConfirmDeleteFolderId(null)

    const url = deleteMeetings
      ? `/api/folders/${folderId}?deleteMeetings=true`
      : `/api/folders/${folderId}`

    try {
      const res = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = (await res.json()) as { error?: string }
        setActionError(data.error ?? 'Failed to delete folder.')
      } else {
        setFolders((prev) => prev.filter((f) => f.id !== folderId))
        if (deleteMeetings) {
          setMeetings((prev) => prev.filter((m) => m.folder_id !== folderId))
        } else {
          setMeetings((prev) => prev.map((m) => m.folder_id === folderId ? { ...m, folder_id: null } : m))
        }
      }
    } catch {
      setActionError('Network error — please try again.')
    } finally {
      setFolderBusy(null)
    }
  }

  // ── share panel actions ────────────────────────────────────────────────────
  async function openSharePanel(folderId: string) {
    setSharingFolderId(folderId)
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
    if (!identifier || !sharingFolderId) return
    const token = await getAccessToken()
    if (!token) return
    setAddShareBusy(true)
    setAddShareError(null)

    try {
      const res = await fetch(`/api/folders/${sharingFolderId}/shares`, {
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
        setFolders((prev) => prev.map((f) => f.id === sharingFolderId ? { ...f, memberCount: f.memberCount + 1 } : f))
      }
    } catch {
      setAddShareError('Network error — please try again.')
    } finally {
      setAddShareBusy(false)
    }
  }

  async function changeShareRole(userId: string, newRole: 'editor' | 'viewer') {
    if (!sharingFolderId) return
    const token = await getAccessToken()
    if (!token) return

    const prev = shareMembers
    setShareMembers((m) => m.map((x) => x.userId === userId ? { ...x, role: newRole } : x))

    try {
      const res = await fetch(`/api/folders/${sharingFolderId}/shares/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ role: newRole }),
      })
      if (!res.ok) {
        setShareMembers(prev)
        setShareError('Failed to change role.')
      }
    } catch {
      setShareMembers(prev)
      setShareError('Network error — please try again.')
    }
  }

  async function removeMember(granteeId: string) {
    if (!sharingFolderId) return
    const token = await getAccessToken()
    if (!token) return

    const prev = shareMembers
    setShareMembers((m) => m.filter((x) => x.userId !== granteeId))
    setFolders((f) => f.map((x) => x.id === sharingFolderId ? { ...x, memberCount: Math.max(0, x.memberCount - 1) } : x))

    try {
      const res = await fetch(`/api/folders/${sharingFolderId}/shares/${granteeId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        setShareMembers(prev)
        setFolders((f) => f.map((x) => x.id === sharingFolderId ? { ...x, memberCount: x.memberCount + 1 } : x))
        setShareError('Failed to remove member.')
      }
    } catch {
      setShareMembers(prev)
      setFolders((f) => f.map((x) => x.id === sharingFolderId ? { ...x, memberCount: x.memberCount + 1 } : x))
      setShareError('Network error — please try again.')
    }
  }

  // ── folder drag-and-drop ───────────────────────────────────────────────────
  async function reorderFolders(reordered: FolderWithRole[]) {
    const token = await getAccessToken()
    if (!token) return
    try {
      await fetch('/api/folders/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ order: reordered.map((f) => f.id) }),
      })
    } catch { /* non-fatal — client state already updated */ }
  }

  function handleFolderDragStart(e: DragEvent, idx: number) {
    setDragFromIndex(idx)
    e.dataTransfer.effectAllowed = 'move'
  }

  function handleFolderDragOver(e: DragEvent, idx: number) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragOverIndex !== idx) setDragOverIndex(idx)
  }

  function handleFolderDrop(e: DragEvent, dropIdx: number) {
    e.preventDefault()
    if (dragFromIndex === null || dragFromIndex === dropIdx) {
      setDragFromIndex(null)
      setDragOverIndex(null)
      return
    }
    const next = [...folders]
    const [moved] = next.splice(dragFromIndex, 1)
    next.splice(dropIdx, 0, moved)
    setFolders(next)
    setDragFromIndex(null)
    setDragOverIndex(null)
    void reorderFolders(next)
  }

  function handleFolderDragEnd() {
    setDragFromIndex(null)
    setDragOverIndex(null)
  }


  // ── derived ────────────────────────────────────────────────────────────────
  // Show skeletons until BOTH the meeting list and the folder list have loaded,
  // so the page doesn't pop content in twice (meetings first, folders after).
  const isInitialLoading = loadState === 'loading' || foldersLoading
  const confirmTarget = confirmDeleteId ? meetings.find((m) => m.id === confirmDeleteId) : null
  const sharingFolder = sharingFolderId ? folders.find((f) => f.id === sharingFolderId) : null
  const editableFolders = folders.filter((f) => f.myRole === 'owner' || f.myRole === 'editor')

  const pinnedMeetings        = meetings.filter((m) => m.pinned_at)
  const nonPinnedMeetings     = meetings.filter((m) => !m.pinned_at)
  const uncategorizedMeetings = nonPinnedMeetings.filter((m) => m.folder_id === null)

  // ── icon helpers ───────────────────────────────────────────────────────────
  function FolderIcon({ shared }: { shared: boolean }) {
    if (shared) return (
      <span style={{ width: 42, height: 42, borderRadius: 12, background: `${T.primary}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <circle cx="9" cy="8" r="3.2" fill={T.primary}/>
          <circle cx="16" cy="9" r="2.6" fill={`${T.primary}80`}/>
          <path d="M3.5 18c0-2.8 2.4-4.6 5.5-4.6s5.5 1.8 5.5 4.6" stroke={T.primary} strokeWidth="2" strokeLinecap="round"/>
          <path d="M15 14c2.4.1 4.4 1.5 4.4 4" stroke={`${T.primary}80`} strokeWidth="2" strokeLinecap="round"/>
        </svg>
      </span>
    )
    return (
      <span style={{ width: 42, height: 42, borderRadius: 12, background: '#fef3d6', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l1.7 1.7H19.5A1.5 1.5 0 0 1 21 9.2v8.3A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10Z" fill="#f6c343"/>
        </svg>
      </span>
    )
  }

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
    const isMoving   = movingMeetingId === m.id
    const myRole     = currentUserId
      ? getMeetingRole({ user_id: m.user_id, folder_id: m.folder_id }, currentUserId, folders)
      : 'viewer'
    const canPinThis    = currentUserId ? canPin({ user_id: m.user_id }, currentUserId) : false
    const canEditThis   = canEdit(myRole)
    const canDeleteThis = canDelete(myRole)

    const statusStyle: Record<string, { color: string; bg: string }> = {
      done:       { color: '#14a06c', bg: '#e3f6ed' },
      pending:    { color: '#8a8b9a', bg: '#f0f0f4' },
      processing: { color: T.primary, bg: `${T.primary}18` },
      failed:     { color: '#ef5a6f', bg: '#fdeef0' },
    }
    const ss = statusStyle[m.status] ?? statusStyle.pending

    const menuItemBase: CSSProperties = {
      width: '100%', textAlign: 'left', padding: '9px 12px', border: 'none',
      background: 'transparent', borderRadius: 8, cursor: 'pointer',
      fontFamily: T.font, fontSize: 13, fontWeight: 600, color: T.fg,
      display: 'flex', alignItems: 'center', gap: 9,
    }

    return (
      <div className="meeting-card" style={{
        display: 'flex', alignItems: 'flex-start', gap: 14,
        background: '#fff',
        border: `1px solid ${m.pinned_at ? T.primary + '50' : T.border}`,
        borderRadius: T.radius, padding: '14px 16px',
        boxShadow: m.pinned_at ? 'var(--t-shadow-sm)' : undefined,
        // While this card's kebab menu is open, lift the whole card above sibling
        // cards so the dropdown (which is trapped inside the card's hover-transform
        // stacking context) isn't overlapped by the next card.
        position: 'relative',
        zIndex: openMenuId === m.id ? 100 : undefined,
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

        {/* ⋯ kebab menu */}
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

  const sectionHeaderStyle: CSSProperties = {
    fontSize: 11, fontWeight: 800, letterSpacing: '0.1em', color: T.fgMuted, fontFamily: T.font,
  }
  const sectionBadgeStyle: CSSProperties = {
    fontSize: 11, fontWeight: 700, color: T.fgMuted, background: T.clay,
    borderRadius: 6, padding: '2px 8px',
  }

  return (
    <div style={{ background: T.bg, minHeight: '100vh', fontFamily: T.font }}>
      <style>{`
        .folder-card { transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease; }
        .folder-card:hover { transform: translateY(-3px); box-shadow: var(--t-shadow-md) !important; border-color: rgb(var(--t-primary-rgb) / 0.3) !important; }
        .meeting-card { transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease; }
        .meeting-card:hover { transform: translateY(-2px); box-shadow: var(--t-shadow-sm) !important; border-color: rgb(var(--t-primary-rgb) / 0.3) !important; }
      `}</style>

      {/* Global click-away overlay — closes all open kebab menus */}
      {openMenuId && (
        <div onClick={() => setOpenMenuId(null)} style={{ position: 'fixed', inset: 0, zIndex: 20 }} />
      )}

      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '36px 28px 80px' }}>

        {/* ── Page header ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 40 }}>
          <h1 style={{ fontSize: 28, fontWeight: 800, color: T.fg, letterSpacing: '-0.02em', margin: 0, fontFamily: 'var(--t-font-heading)' }}>
            Meetings
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              onClick={() => { setManageFoldersOpen(true); setNewFolderName(''); setNewFolderError(null); setSharingFolderId(null) }}
              style={{ padding: '10px 20px', borderRadius: 999, border: `1.5px solid ${T.border}`, background: 'white', color: T.fg, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: T.font }}
            >
              + New folder
            </button>
            <Link
              href="/record"
              style={{ padding: '10px 22px', borderRadius: 999, border: 'none', background: T.primary, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: T.font, textDecoration: 'none', display: 'inline-block' }}
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

        {/* ── Loading skeletons — mirror the real layout (folder grid + meeting rows) ── */}
        {isInitialLoading && loadState !== 'error' && (
          <div>
            {/* Folders section skeleton */}
            <section style={{ marginBottom: 36 }}>
              <div style={{ width: 90, height: 12, borderRadius: 6, background: T.border, animation: 'pulse 1.5s ease-in-out infinite', marginBottom: 16 }} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, background: 'white', border: `1.5px solid ${T.border}`, borderRadius: T.radius, padding: 16 }}>
                    <div style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 12, background: T.border, animation: 'pulse 1.5s ease-in-out infinite', animationDelay: `${i * 80}ms` }} />
                    <div style={{ flex: 1, paddingTop: 4 }}>
                      <div style={{ width: '60%', height: 12, borderRadius: 6, background: T.border, animation: 'pulse 1.5s ease-in-out infinite', animationDelay: `${i * 80}ms`, marginBottom: 8 }} />
                      <div style={{ width: '35%', height: 10, borderRadius: 5, background: T.clay, animation: 'pulse 1.5s ease-in-out infinite', animationDelay: `${i * 80}ms` }} />
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Meeting list skeleton */}
            <section>
              <div style={{ width: 130, height: 12, borderRadius: 6, background: T.border, animation: 'pulse 1.5s ease-in-out infinite', marginBottom: 14 }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14, background: 'white', border: `1px solid ${T.border}`, borderRadius: T.radius, padding: '14px 16px' }}>
                    <div style={{ width: 46, height: 46, flexShrink: 0, borderRadius: 12, background: T.border, animation: 'pulse 1.5s ease-in-out infinite', animationDelay: `${i * 90}ms` }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ width: '45%', height: 13, borderRadius: 6, background: T.border, animation: 'pulse 1.5s ease-in-out infinite', animationDelay: `${i * 90}ms`, marginBottom: 9 }} />
                      <div style={{ width: '28%', height: 10, borderRadius: 5, background: T.clay, animation: 'pulse 1.5s ease-in-out infinite', animationDelay: `${i * 90}ms` }} />
                    </div>
                    <div style={{ width: 30, height: 30, flexShrink: 0, borderRadius: 9, background: '#eef0f3', animation: 'pulse 1.5s ease-in-out infinite', animationDelay: `${i * 90}ms` }} />
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {/* ── Error state ── */}
        {loadState === 'error' && (
          <div className="banner-error" style={{ marginTop: 8 }}>{loadError}</div>
        )}

        {/* ── Empty state ── */}
        {!isInitialLoading && loadState === 'ready' && meetings.length === 0 && folders.length === 0 && (
          <div style={{ textAlign: 'center', padding: '80px 0' }}>
            <div style={{ width: 64, height: 64, borderRadius: '50%', background: `${T.primary}20`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px', fontSize: 28 }}>🎙</div>
            <p style={{ fontSize: 20, fontWeight: 800, color: T.fg, marginBottom: 8, fontFamily: 'var(--t-font-heading)' }}>No meetings yet</p>
            <p style={{ fontSize: 14, color: T.fgMuted, marginBottom: 28 }}>Record your first meeting to get started.</p>
            <Link href="/record" style={{ padding: '12px 28px', borderRadius: 999, border: 'none', background: T.primary, color: '#fff', fontSize: 14, fontWeight: 700, textDecoration: 'none', display: 'inline-block' }}>
              Record your first meeting
            </Link>
          </div>
        )}

        {/* ── Main content ── */}
        {!isInitialLoading && loadState === 'ready' && (meetings.length > 0 || folders.length > 0) && (
          <>

            {/* 1. PINNED */}
            {pinnedMeetings.length > 0 && (
              <section style={{ marginBottom: 36 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                  <span style={sectionHeaderStyle}>PINNED</span>
                  <span style={sectionBadgeStyle}>{pinnedMeetings.length}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {pinnedMeetings.map((m) => <div key={m.id}>{renderMeeting(m)}</div>)}
                </div>
              </section>
            )}

            {/* 2. FOLDERS */}
            {folders.length > 0 && (
              <section style={{ marginBottom: 36 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                  <span style={sectionHeaderStyle}>FOLDERS</span>
                  <span style={sectionBadgeStyle}>{folders.length}</span>
                </div>

                {/* 2-column grid */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
                  {folders.map((f, idx) => {
                    const isOwned        = f.myRole === 'owner'
                    const canRename      = f.myRole === 'owner' || f.myRole === 'editor'
                    const isDragging     = dragFromIndex === idx
                    const isDropTarget   = dragOverIndex === idx && dragFromIndex !== null && dragFromIndex !== idx
                    const isRenaming     = renamingFolderId === f.id
                    const isConfirmingDelete = confirmDeleteFolderId === f.id
                    const deleteCounts   = folderDeleteCounts(meetings, f.id, currentUserId ?? '')
                    const isShared       = isOwned ? f.memberCount > 0 : true

                    const folderMenuItemBase: CSSProperties = {
                      width: '100%', textAlign: 'left', padding: '9px 12px', border: 'none',
                      background: 'transparent', borderRadius: 8, cursor: 'pointer',
                      fontFamily: T.font, fontSize: 13, fontWeight: 600, color: T.fg,
                      display: 'flex', alignItems: 'center', gap: 9,
                    }

                    return (
                      <div key={f.id}>
                        {/* Folder card */}
                        <div
                          className="folder-card"
                          draggable={isOwned && !isRenaming}
                          onDragStart={isOwned && !isRenaming ? (e) => handleFolderDragStart(e, idx) : undefined}
                          onDragOver={isOwned && !isRenaming ? (e) => handleFolderDragOver(e, idx) : undefined}
                          onDrop={isOwned && !isRenaming ? (e) => handleFolderDrop(e, idx) : undefined}
                          onDragEnd={handleFolderDragEnd}
                          style={{
                            background: 'white', borderRadius: T.radius, padding: '16px',
                            border: `1.5px solid ${isDropTarget ? T.primary : isRenaming ? T.primary : T.border}`,
                            boxShadow: isDragging ? 'none' : 'var(--t-shadow-sm)',
                            opacity: isDragging ? 0.4 : 1,
                            userSelect: 'none',
                            // Lift above sibling cards while this card's kebab menu is open so the
                            // dropdown (trapped in the hover-transform stacking context) stays clickable.
                            position: 'relative',
                            zIndex: openMenuId === f.id ? 100 : undefined,
                          }}
                        >
                          {isRenaming ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                              <input
                                style={{ width: '100%', boxSizing: 'border-box', padding: '8px 12px', borderRadius: 'var(--t-radius-input)', border: `1px solid ${T.primary}`, background: T.clay, fontSize: 14, fontWeight: 600, fontFamily: T.font, outline: 'none' }}
                                value={renameFolderTitle}
                                maxLength={100}
                                autoFocus
                                onChange={(e) => setRenameFolderTitle(e.target.value)}
                                onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                                  if (e.key === 'Enter') void saveRenameFolder(f.id)
                                  if (e.key === 'Escape') { setRenamingFolderId(null); setRenameFolderError(null) }
                                }}
                              />
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button disabled={folderBusy === f.id} onClick={() => void saveRenameFolder(f.id)} style={{ padding: '6px 14px', borderRadius: 999, border: 'none', background: T.primary, color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: T.font }}>Save</button>
                                <button onClick={() => { setRenamingFolderId(null); setRenameFolderError(null) }} style={{ padding: '6px 14px', borderRadius: 999, border: `1px solid ${T.border}`, background: 'white', color: T.fgSubtle, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: T.font }}>Cancel</button>
                              </div>
                              {renameFolderError && <p style={{ fontSize: 11, color: '#ef5a6f', margin: 0 }}>{renameFolderError}</p>}
                            </div>
                          ) : (
                            <>
                              {/* Card header: icon + name (link) + kebab */}
                              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                                {/* Clickable body: icon + name navigate to folder */}
                                <Link href={`/meetings/folder/${f.id}`} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'flex-start', gap: 12, textDecoration: 'none' }}>
                                  <span style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 12, background: isShared ? '#efedfd' : '#fef3d6', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <FolderIcon shared={isShared} />
                                  </span>
                                  <div style={{ flex: 1, minWidth: 0, paddingTop: 2 }}>
                                    <p style={{ fontSize: 14, fontWeight: 700, color: T.fg, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: '0 0 3px' }}>{f.name}</p>
                                    <p style={{ fontSize: 11, fontWeight: 500, color: T.fgMuted, margin: 0 }}>
                                      {deleteCounts.total} meeting{deleteCounts.total !== 1 ? 's' : ''}
                                      {isOwned && f.memberCount > 0 && ` · ${f.memberCount} member${f.memberCount !== 1 ? 's' : ''}`}
                                      {!isOwned && ` · @${f.ownerUsername ?? '?'} · ${f.myRole}`}
                                    </p>
                                  </div>
                                </Link>
                                {/* ⋯ kebab — outside the Link so clicks don't navigate */}
                                <div style={{ position: 'relative', flexShrink: 0 }}>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === f.id ? null : f.id) }}
                                    style={{ width: 30, height: 30, borderRadius: 9, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2.5, zIndex: 21, position: 'relative' }}
                                  ><KebabDots /></button>
                                  {openMenuId === f.id && (
                                    <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: 160, background: 'white', border: `1px solid ${T.border}`, borderRadius: 12, boxShadow: 'var(--t-shadow-xl)', padding: 6, zIndex: 50 }}>
                                      <Link href={`/meetings/folder/${f.id}`} onClick={() => setOpenMenuId(null)} style={{ ...folderMenuItemBase, textDecoration: 'none', color: T.fg }}>
                                        <span style={{ color: T.fgMuted }}>▸</span> Open folder
                                      </Link>
                                      {canRename && (
                                        <button disabled={folderBusy === f.id} onClick={() => { setOpenMenuId(null); startRenameFolder(f); setConfirmDeleteFolderId(null) }} style={folderMenuItemBase}>
                                          <span style={{ color: T.fgMuted }}>✎</span> Rename
                                        </button>
                                      )}
                                      {isOwned && (
                                        <button onClick={() => { setOpenMenuId(null); void openSharePanel(f.id) }} style={folderMenuItemBase}>
                                          <span style={{ color: T.fgMuted }}>👥</span> Share
                                        </button>
                                      )}
                                      {isOwned && (
                                        <>
                                          <div style={{ height: 1, background: T.clay, margin: '4px 6px' }} />
                                          <button disabled={folderBusy === f.id} onClick={() => { setOpenMenuId(null); setConfirmDeleteFolderId(f.id); setRenamingFolderId(null) }} style={{ ...folderMenuItemBase, color: 'rgb(239 68 68)', fontWeight: 700 }}>
                                            <span>🗑</span> Delete
                                          </button>
                                        </>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </>
                          )}
                        </div>

                        {/* Delete confirm panel — below card */}
                        {isConfirmingDelete && (
                          <div style={{ background: 'rgb(254 242 242)', border: '1.5px solid rgb(252 165 165)', borderRadius: 14, marginTop: 8, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                            <p style={{ fontSize: 12, fontWeight: 700, color: 'rgb(185 28 28)', margin: 0 }}>Delete &ldquo;{f.name}&rdquo;?</p>
                            <p style={{ fontSize: 12, color: '#c0202e', margin: 0, lineHeight: 1.5 }}>{folderDeleteChatNotice(f.memberCount)}</p>
                            {deleteCounts.deletable > 0 ? (
                              <>
                                <p style={{ fontSize: 12, color: '#c0202e', margin: 0, lineHeight: 1.5 }}>
                                  This folder has {deleteCounts.total} meeting{deleteCounts.total !== 1 ? 's' : ''} inside. What should happen to them?
                                  {deleteCounts.othersMoved > 0 && ` ${deleteCounts.othersMoved} of them belong${deleteCounts.othersMoved === 1 ? 's' : ''} to shared members and will move to their Uncategorized either way.`}
                                </p>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                  <button disabled={folderBusy === f.id} onClick={() => void deleteFolder(f.id, false)} style={{ textAlign: 'left', padding: '8px 12px', borderRadius: 10, border: '1.5px solid #f9c6cc', background: '#fff', color: '#c0202e', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                                    Keep meetings — move to Uncategorized
                                  </button>
                                  <button disabled={folderBusy === f.id} onClick={() => void deleteFolder(f.id, true)} style={{ textAlign: 'left', padding: '8px 12px', borderRadius: 10, border: 'none', background: '#ef5a6f', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                                    Delete folder + {deleteCounts.othersMoved > 0 ? 'my' : 'all'} {deleteCounts.deletable} meeting{deleteCounts.deletable !== 1 ? 's' : ''}
                                  </button>
                                  <button onClick={() => setConfirmDeleteFolderId(null)} style={{ textAlign: 'left', padding: '7px 12px', borderRadius: 10, border: '1px solid #f9c6cc', background: 'transparent', color: '#ef5a6f', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
                                </div>
                              </>
                            ) : (
                              <>
                              {deleteCounts.total > 0 && (
                                <p style={{ fontSize: 12, color: '#c0202e', margin: 0, lineHeight: 1.5 }}>
                                  The {deleteCounts.total} meeting{deleteCounts.total !== 1 ? 's' : ''} inside {deleteCounts.othersMoved === deleteCounts.total
                                    ? `${deleteCounts.total !== 1 ? 'belong' : 'belongs'} to shared members and will move to their Uncategorized.`
                                    : 'will move to Uncategorized.'}
                                </p>
                              )}
                              <div style={{ display: 'flex', gap: 8 }}>
                                <button disabled={folderBusy === f.id} onClick={() => void deleteFolder(f.id, false)} style={{ padding: '6px 14px', borderRadius: 999, border: 'none', background: '#ef5a6f', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Delete folder</button>
                                <button onClick={() => setConfirmDeleteFolderId(null)} style={{ padding: '6px 14px', borderRadius: 999, border: '1.5px solid #f9c6cc', background: 'transparent', color: '#ef5a6f', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
                              </div>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>

              </section>
            )}

            {/* 3. UNCATEGORIZED */}
            {uncategorizedMeetings.length > 0 && (
              <section>
                {(folders.length > 0 || pinnedMeetings.length > 0) && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                    <span style={sectionHeaderStyle}>UNCATEGORIZED</span>
                    <span style={sectionBadgeStyle}>{uncategorizedMeetings.length}</span>
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {uncategorizedMeetings.map((m) => <div key={m.id}>{renderMeeting(m)}</div>)}
                </div>
              </section>
            )}

          </>
        )}

      </div>

      {/* ── Delete meeting confirmation dialog ── */}
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
                onClick={() => { void deleteMeeting(confirmTarget.id) }}
                style={{ padding: '10px 20px', borderRadius: 999, border: 'none', background: '#ef5a6f', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: busyId === confirmTarget.id ? 0.65 : 1 }}
              >
                Delete permanently
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Standalone Share folder modal ── */}
      {sharingFolderId && !manageFoldersOpen && (
        <div
          className="fixed inset-0 bg-b-fg/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={() => { setSharingFolderId(null); setShareError(null) }}
        >
          <div
            className="bg-white rounded-3xl border border-b-border shadow-b-xl p-8 max-w-md w-full max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-6">
              <h3 className="font-serif text-xl font-bold text-b-fg">Share &ldquo;{sharingFolder?.name}&rdquo;</h3>
              <button onClick={() => { setSharingFolderId(null); setShareError(null) }} className="text-b-fg/40 hover:text-b-fg text-xl cursor-pointer bg-transparent border-0 leading-none">✕</button>
            </div>
            {shareError && <p className="text-xs text-red-500 mb-3">{shareError}</p>}
            <div className="flex flex-col gap-2 overflow-y-auto flex-1 min-h-0 mb-4">
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-b-clay/50">
                <span className="flex-1 text-sm font-semibold text-b-fg truncate">You</span>
                <span className="text-xs text-b-fg/40 font-semibold uppercase tracking-wide px-2 py-0.5 rounded border border-b-border">Owner</span>
              </div>
              {shareBusy && <p className="text-xs text-b-fg/40 font-sans py-2 text-center animate-pulse">Loading members…</p>}
              {!shareBusy && shareMembers.map((member) => (
                <div key={member.userId} className="flex items-center gap-2 px-3 py-2 rounded-xl border border-b-border">
                  <span className="flex-1 text-sm text-b-fg truncate">@{member.username}</span>
                  <select value={member.role} onChange={(e) => void changeShareRole(member.userId, e.target.value as 'editor' | 'viewer')} className="text-xs border border-b-border rounded-lg px-2 py-1 bg-white text-b-fg focus:outline-none cursor-pointer">
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                  </select>
                  <button onClick={() => void removeMember(member.userId)} className="text-xs text-red-400 hover:text-red-600 cursor-pointer bg-transparent border-0 px-1">Remove</button>
                </div>
              ))}
              {!shareBusy && shareMembers.length === 0 && <p className="text-xs text-b-fg/40 font-sans py-2 text-center">No members yet — add someone below.</p>}
            </div>
            <div className="border-t border-b-border pt-4">
              <p className="text-xs font-semibold text-b-fg/60 font-sans uppercase tracking-wide mb-2">Add member</p>
              <div className="flex gap-2 mb-2">
                <input type="text" value={addShareIdentifier} onChange={(e) => setAddShareIdentifier(e.target.value)} placeholder="Email or @username" disabled={addShareBusy} className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-b-border bg-b-clay text-sm font-sans text-b-fg focus:outline-none focus:ring-2 focus:ring-b-primary/40 disabled:opacity-50" onKeyDown={(e) => { if (e.key === 'Enter') void addShareMember() }} />
                <select value={addShareRole} onChange={(e) => setAddShareRole(e.target.value as 'editor' | 'viewer')} className="text-sm border border-b-border rounded-xl px-2 py-2 bg-b-clay text-b-fg focus:outline-none cursor-pointer flex-shrink-0">
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                </select>
                <button onClick={() => void addShareMember()} disabled={!addShareIdentifier.trim() || addShareBusy} className="flex-shrink-0 px-4 py-2 rounded-xl bg-b-primary text-white text-sm font-semibold disabled:opacity-40 cursor-pointer border-0 hover:opacity-90 transition-opacity">Add</button>
              </div>
              {addShareError && <p className="text-xs text-red-500">{addShareError}</p>}
              <p className="text-xs text-b-fg/40 font-sans mt-1">Viewer: read-only · Editor: can rename and delete meetings in this folder</p>
            </div>
          </div>
        </div>
      )}

      {/* ── Manage folders modal ── */}
      {manageFoldersOpen && (
        <div
          className="fixed inset-0 bg-b-fg/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={() => {
            setManageFoldersOpen(false)
            setRenamingFolderId(null)
            setConfirmDeleteFolderId(null)
            setSharingFolderId(null)
          }}
        >
          <div
            className="bg-white rounded-3xl border border-b-border shadow-b-xl p-8 max-w-md w-full max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Share panel (replaces folder list when a folder is being shared) */}
            {sharingFolderId ? (
              <>
                <div className="flex items-center gap-3 mb-6">
                  <button
                    onClick={() => { setSharingFolderId(null); setShareError(null) }}
                    className="text-b-fg/40 hover:text-b-fg text-sm cursor-pointer bg-transparent border-0"
                  >
                    ← Back
                  </button>
                  <h3 className="font-serif text-xl font-bold text-b-fg">
                    Share &ldquo;{sharingFolder?.name}&rdquo;
                  </h3>
                </div>

                {shareError && (
                  <p className="text-xs text-red-500 mb-3">{shareError}</p>
                )}

                {/* Owner row */}
                <div className="flex flex-col gap-2 overflow-y-auto flex-1 min-h-0 mb-4">
                  {currentUserId && sharingFolder && (
                    <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-b-clay/50">
                      <span className="flex-1 text-sm font-semibold text-b-fg truncate">
                        @{folders.find((f) => f.id === sharingFolderId)?.ownerUsername ?? 'You'}
                      </span>
                      <span className="text-xs text-b-fg/40 font-semibold uppercase tracking-wide px-2 py-0.5 rounded border border-b-border">Owner</span>
                    </div>
                  )}

                  {shareBusy && (
                    <p className="text-xs text-b-fg/40 font-sans py-2 text-center animate-pulse">Loading members…</p>
                  )}

                  {!shareBusy && shareMembers.map((member) => (
                    <div key={member.userId} className="flex items-center gap-2 px-3 py-2 rounded-xl border border-b-border">
                      <span className="flex-1 text-sm text-b-fg truncate">@{member.username}</span>
                      <select
                        value={member.role}
                        onChange={(e) => void changeShareRole(member.userId, e.target.value as 'editor' | 'viewer')}
                        className="text-xs border border-b-border rounded-lg px-2 py-1 bg-white text-b-fg focus:outline-none cursor-pointer"
                      >
                        <option value="viewer">Viewer</option>
                        <option value="editor">Editor</option>
                      </select>
                      <button
                        onClick={() => void removeMember(member.userId)}
                        className="text-xs text-red-400 hover:text-red-600 cursor-pointer bg-transparent border-0 px-1"
                      >
                        Remove
                      </button>
                    </div>
                  ))}

                  {!shareBusy && shareMembers.length === 0 && (
                    <p className="text-xs text-b-fg/40 font-sans py-2 text-center">No members yet — add someone below.</p>
                  )}
                </div>

                {/* Add member form */}
                <div className="border-t border-b-border pt-4">
                  <p className="text-xs font-semibold text-b-fg/60 font-sans uppercase tracking-wide mb-2">Add member</p>
                  <div className="flex gap-2 mb-2">
                    <input
                      type="text"
                      value={addShareIdentifier}
                      onChange={(e) => setAddShareIdentifier(e.target.value)}
                      placeholder="Email or @username"
                      disabled={addShareBusy}
                      className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-b-border bg-b-clay text-sm font-sans text-b-fg focus:outline-none focus:ring-2 focus:ring-b-primary/40 disabled:opacity-50"
                      onKeyDown={(e) => { if (e.key === 'Enter') void addShareMember() }}
                    />
                    <select
                      value={addShareRole}
                      onChange={(e) => setAddShareRole(e.target.value as 'editor' | 'viewer')}
                      className="text-sm border border-b-border rounded-xl px-2 py-2 bg-b-clay text-b-fg focus:outline-none cursor-pointer flex-shrink-0"
                    >
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                    </select>
                    <button
                      onClick={() => void addShareMember()}
                      disabled={!addShareIdentifier.trim() || addShareBusy}
                      className="flex-shrink-0 px-4 py-2 rounded-xl bg-b-primary text-white text-sm font-semibold disabled:opacity-40 cursor-pointer border-0 hover:opacity-90 transition-opacity"
                    >
                      Add
                    </button>
                  </div>
                  {addShareError && <p className="text-xs text-red-500">{addShareError}</p>}
                  <p className="text-xs text-b-fg/40 font-sans mt-1">
                    Viewer: read-only · Editor: can rename and delete meetings in this folder
                  </p>
                </div>
              </>
            ) : (
              <>
                <h3 className="font-serif text-xl font-bold text-b-fg mb-6">Folders</h3>

                {/* Folder list */}
                <div className="flex-1 overflow-y-auto flex flex-col gap-2 mb-6 min-h-0">
                  {folders.length === 0 && (
                    <p className="text-sm text-b-fg/40 font-sans text-center py-4">No folders yet — create one below.</p>
                  )}
                  {folders.map((f) => {
                    const count = meetings.filter((m) => m.folder_id === f.id).length
                    const isRenaming = renamingFolderId === f.id
                    const isConfirmingDelete = confirmDeleteFolderId === f.id
                    const isOwned = canManageShares(f, currentUserId ?? '')

                    return (
                      <div key={f.id} className="flex flex-col gap-2 rounded-2xl border border-b-border px-4 py-3">
                        {isRenaming ? (
                          <div className="flex items-center gap-2">
                            <input
                              className="flex-1 min-w-0 px-3 py-1.5 rounded-xl bg-b-clay border border-b-primary text-b-fg text-sm font-semibold outline-none"
                              value={renameFolderTitle}
                              maxLength={100}
                              autoFocus
                              onChange={(e) => setRenameFolderTitle(e.target.value)}
                              onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                                if (e.key === 'Enter') void saveRenameFolder(f.id)
                                if (e.key === 'Escape') { setRenamingFolderId(null); setRenameFolderError(null) }
                              }}
                            />
                            <button
                              disabled={folderBusy === f.id}
                              onClick={() => { void saveRenameFolder(f.id) }}
                              className="px-3 py-1.5 rounded-full bg-b-fg text-white text-xs font-semibold cursor-pointer border-0 hover:opacity-80 flex-shrink-0"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => { setRenamingFolderId(null); setRenameFolderError(null) }}
                              className="px-3 py-1.5 rounded-full border border-b-border text-b-fg/60 text-xs cursor-pointer bg-transparent hover:bg-b-clay flex-shrink-0"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="flex-1 min-w-0 text-sm font-semibold text-b-fg truncate">
                              {f.myRole !== 'owner' ? '👥' : '📁'} {f.name}
                              {f.myRole !== 'owner' && (
                                <span className="ml-1.5 text-xs font-normal text-b-fg/40">
                                  by @{f.ownerUsername} · {f.myRole}
                                </span>
                              )}
                            </span>
                            <span className="text-xs text-b-fg/40 flex-shrink-0">
                              {count} meeting{count !== 1 ? 's' : ''}
                            </span>
                            {isOwned && (
                              <>
                                <button
                                  onClick={() => void openSharePanel(f.id)}
                                  className="px-2.5 py-1 rounded-full border border-b-primary/40 text-b-primary text-xs cursor-pointer bg-transparent hover:bg-b-primary/10 transition-colors flex-shrink-0"
                                >
                                  Share
                                </button>
                                <button
                                  disabled={folderBusy === f.id}
                                  onClick={() => startRenameFolder(f)}
                                  className="px-2.5 py-1 rounded-full border border-b-border text-b-fg/60 text-xs cursor-pointer bg-transparent hover:bg-b-clay hover:text-b-fg transition-colors flex-shrink-0"
                                >
                                  Rename
                                </button>
                                <button
                                  disabled={folderBusy === f.id}
                                  onClick={() => { setConfirmDeleteFolderId(f.id); setRenamingFolderId(null) }}
                                  className="px-2.5 py-1 rounded-full border border-red-100 text-red-400 text-xs cursor-pointer bg-transparent hover:bg-red-50 hover:text-red-600 transition-colors flex-shrink-0"
                                >
                                  Delete
                                </button>
                              </>
                            )}
                          </div>
                        )}

                        {renameFolderError && isRenaming && (
                          <p className="text-xs text-red-500">{renameFolderError}</p>
                        )}

                        {/* Inline delete confirmation */}
                        {isConfirmingDelete && (
                          <div className="bg-red-50 border border-red-200 rounded-xl p-3 flex flex-col gap-2">
                            <p className="text-xs text-red-700 font-sans leading-relaxed">
                              Delete <strong>&ldquo;{f.name}&rdquo;</strong>?
                              {count > 0
                                ? ` The ${count} meeting${count !== 1 ? 's' : ''} inside will move to Uncategorized — they won't be deleted.`
                                : ' This folder is empty.'}
                              {` ${folderDeleteChatNotice(f.memberCount)}`}
                            </p>
                            <div className="flex gap-2">
                              <button
                                disabled={folderBusy === f.id}
                                onClick={() => { void deleteFolder(f.id, false) }}
                                className="px-3 py-1 rounded-full bg-red-600 text-white text-xs font-semibold cursor-pointer border-0 hover:bg-red-700 transition-colors disabled:opacity-60"
                              >
                                Delete folder
                              </button>
                              <button
                                onClick={() => setConfirmDeleteFolderId(null)}
                                className="px-3 py-1 rounded-full border border-red-200 text-red-600 text-xs cursor-pointer bg-transparent hover:bg-red-50 transition-colors"
                              >
                                Keep it
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>

                {/* Create new folder */}
                <div className="border-t border-b-border pt-4">
                  <p className="text-xs font-semibold text-b-fg/60 font-sans uppercase tracking-wide mb-2">New folder</p>
                  <form
                    onSubmit={(e) => { e.preventDefault(); void createFolder() }}
                    className="flex gap-2"
                  >
                    <input
                      type="text"
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      placeholder="e.g. Sprint Reviews"
                      maxLength={100}
                      disabled={newFolderBusy}
                      className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-b-border bg-b-clay text-sm font-sans text-b-fg focus:outline-none focus:ring-2 focus:ring-b-primary/40 disabled:opacity-50"
                    />
                    <button
                      type="submit"
                      disabled={!newFolderName.trim() || newFolderBusy}
                      className="flex-shrink-0 px-4 py-2 rounded-xl bg-b-primary text-white text-sm font-semibold disabled:opacity-40 cursor-pointer border-0 hover:opacity-90 transition-opacity"
                    >
                      Create
                    </button>
                  </form>
                  {newFolderError && <p className="text-xs text-red-500 mt-1.5">{newFolderError}</p>}
                </div>

                {/* Close */}
                <button
                  onClick={() => setManageFoldersOpen(false)}
                  className="mt-4 self-end text-xs text-b-fg/40 font-sans hover:text-b-fg/60 transition-colors cursor-pointer bg-transparent border-0"
                >
                  Close
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
