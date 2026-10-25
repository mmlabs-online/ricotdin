'use client'

import { useEffect, useRef, useState } from 'react'
import { getAccessToken } from '@/lib/supabase/auth'
import type { FolderWithRole } from '@/types/database'

export interface FolderSelectorProps {
  /** Currently selected folder id, or null for Uncategorized. */
  value: string | null
  onChange: (folderId: string | null) => void
  disabled?: boolean
  className?: string
}

async function fetchFolders(): Promise<FolderWithRole[]> {
  const token = await getAccessToken()
  if (!token) return []
  const res = await fetch('/api/folders', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return []
  const json = (await res.json()) as { folders: FolderWithRole[] }
  // Only show folders the user can assign meetings to (owned or editor-accessible)
  return json.folders.filter((f) => f.myRole === 'owner' || f.myRole === 'editor')
}

async function createFolder(name: string): Promise<FolderWithRole | null> {
  const token = await getAccessToken()
  if (!token) return null
  const res = await fetch('/api/folders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  const json = (await res.json()) as { folder: FolderWithRole }
  return json.folder
}

export default function FolderSelector({ value, onChange, disabled, className }: FolderSelectorProps) {
  const [folders, setFolders] = useState<FolderWithRole[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const newNameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setLoading(true)
    fetchFolders()
      .then(setFolders)
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (creating) newNameRef.current?.focus()
  }, [creating])

  function handleSelectChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const v = e.target.value
    if (v === '__new__') {
      setCreating(true)
      setNewName('')
      setError(null)
      return
    }
    onChange(v === '' ? null : v)
  }

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault()
    const name = newName.trim()
    if (!name) return
    setError(null)
    try {
      const folder = await createFolder(name)
      if (!folder) return
      setFolders((prev) => [...prev, folder].sort((a, b) => a.name.localeCompare(b.name)))
      onChange(folder.id)
      setCreating(false)
      setNewName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create folder.')
    }
  }

  function handleCreateCancel() {
    setCreating(false)
    setNewName('')
    setError(null)
  }

  const inputCls =
    'w-full rounded-xl border border-b-border bg-b-clay px-3 py-2 text-sm font-sans text-b-fg focus:outline-none focus:ring-2 focus:ring-b-primary/40 disabled:opacity-50'

  if (creating) {
    return (
      <form onSubmit={(e) => { void handleCreateSubmit(e) }} className={`flex flex-col gap-2 ${className ?? ''}`}>
        <label className="text-xs font-semibold text-b-fg/60 font-sans uppercase tracking-wide">
          New folder name
        </label>
        <div className="flex gap-2">
          <input
            ref={newNameRef}
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Sprint Reviews"
            maxLength={100}
            className={inputCls}
            disabled={disabled}
          />
          <button
            type="submit"
            disabled={!newName.trim() || disabled}
            className="shrink-0 px-4 py-2 rounded-xl bg-b-primary text-white text-sm font-semibold disabled:opacity-40 cursor-pointer border-0 hover:opacity-90 transition-opacity"
          >
            Create
          </button>
          <button
            type="button"
            onClick={handleCreateCancel}
            disabled={disabled}
            className="shrink-0 px-4 py-2 rounded-xl border border-b-border text-sm font-semibold text-b-fg/70 cursor-pointer bg-transparent hover:bg-b-clay transition-colors"
          >
            Cancel
          </button>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </form>
    )
  }

  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ''}`}>
      <label className="text-xs font-semibold text-b-fg/60 font-sans uppercase tracking-wide">
        Folder
      </label>
      <select
        value={value ?? ''}
        onChange={handleSelectChange}
        disabled={disabled || loading}
        className={`${inputCls} cursor-pointer`}
      >
        <option value="">Uncategorized</option>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
        <option value="__new__">+ New folder…</option>
      </select>
    </div>
  )
}
