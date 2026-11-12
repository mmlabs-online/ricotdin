'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getCurrentRole, getAccessToken } from '@/lib/supabase/auth'

// ── Types ─────────────────────────────────────────────────────────────────────

type EntryStatus = 'active' | 'disabled'
type HealthStatus = 'healthy' | 'unhealthy' | 'unknown'

type ConfigEntry = {
  id: string
  created_at: string
  config_key: string
  label: string
  last4: string
  status: EntryStatus
  disabled_reason: string | null
  last_used_at: string | null
  health_status: HealthStatus | null
  health_checked_at: string | null
  health_detail: string | null
}

type HealthSummary = { total: number; healthy: number; unhealthy: number; unknown: number }

// Known config keys and their display names
const CONFIG_KEYS = [
  { value: 'gemini_api_key',       display: 'Gemini' },
  { value: 'openai_api_key',       display: 'OpenAI' },
  { value: 'grok_api_key',         display: 'Grok (xAI)' },
  { value: 'speechmatics_api_key', display: 'Speechmatics' },
] as const
type ConfigKeyValue = typeof CONFIG_KEYS[number]['value']

const DISPLAY_NAME: Record<string, string> = Object.fromEntries(
  CONFIG_KEYS.map(({ value, display }) => [value, display]),
)

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

const HEALTH_STYLE: Record<HealthStatus, { bg: string; fg: string; label: string }> = {
  healthy:   { bg: '#dcfce7', fg: '#16a34a', label: 'Healthy' },
  unhealthy: { bg: '#fee2e2', fg: '#dc2626', label: 'Unhealthy' },
  unknown:   { bg: '#fef9c3', fg: '#a16207', label: 'Unknown' },
}

// Most recent health_checked_at across all entries, or null if never checked.
function latestCheckedAt(entries: ConfigEntry[]): string | null {
  let latest: string | null = null
  for (const e of entries) {
    if (e.health_checked_at && (!latest || e.health_checked_at > latest)) {
      latest = e.health_checked_at
    }
  }
  return latest
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function KeysPage() {
  const [loading, setLoading]         = useState(true)
  const [forbidden, setForbidden]     = useState(false)
  const [entries, setEntries]         = useState<ConfigEntry[]>([])
  const [error, setError]             = useState<string | null>(null)
  const [success, setSuccess]         = useState<string | null>(null)
  const [busyId, setBusyId]           = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete]   = useState<ConfigEntry | null>(null)
  const [confirmDisable, setConfirmDisable] = useState<ConfigEntry | null>(null)

  // Health check
  const [healthBusy, setHealthBusy]       = useState(false)
  const [healthSummary, setHealthSummary] = useState<HealthSummary | null>(null)

  // Add-key form
  const [formConfigKey, setFormConfigKey] = useState<ConfigKeyValue>('gemini_api_key')
  const [formLabel, setFormLabel]         = useState('')
  const [formKey, setFormKey]             = useState('')
  const [formBusy, setFormBusy]           = useState(false)
  const [formError, setFormError]         = useState<string | null>(null)
  const [justAdded, setJustAdded]         = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)

  const fetchEntries = useCallback(async (token: string, signal: AbortSignal) => {
    const res = await fetch('/api/admin/keys', {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    })
    if (signal.aborted) return
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string }
      setError(data.error ?? `Failed to load keys (HTTP ${res.status}).`)
      return
    }
    const data = await res.json() as { keys: ConfigEntry[]; healthColumnsMissing?: boolean }
    setEntries(data.keys)
    if (data.healthColumnsMissing) {
      setError('Health-check columns are missing — apply migration 029_admin_config_health.sql to enable key health checks.')
    }
  }, [])

  const refresh = useCallback(async () => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    const { signal } = abortRef.current
    const token = await getAccessToken()
    if (!token || signal.aborted) return
    try {
      await fetchEntries(token, signal)
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') setError('Failed to load keys.')
    }
  }, [fetchEntries])

  useEffect(() => {
    async function init() {
      const role = await getCurrentRole()
      if (role !== 'admin') { setForbidden(true); setLoading(false); return }
      await refresh()
      setLoading(false)
    }
    void init()
    return () => abortRef.current?.abort()
  }, [refresh])

  // ── Add entry ──────────────────────────────────────────────────────────────

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setFormError(null)
    setFormBusy(true)
    setJustAdded(null)
    setSuccess(null)
    try {
      const token = await getAccessToken()
      if (!token) { setFormError('Not authenticated.'); return }
      const res = await fetch('/api/admin/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ configKey: formConfigKey, label: formLabel.trim(), key: formKey.trim() }),
      })
      const data = await res.json()
      if (!res.ok) { setFormError(data.error ?? 'Failed to add key.'); return }
      setFormLabel('')
      setFormKey('')
      setJustAdded(
        `Key "${data.key.label}" (••••${data.key.last4}) saved for ${DISPLAY_NAME[formConfigKey]}. ` +
        'It cannot be viewed again.',
      )
      await refresh()
    } catch {
      setFormError('Network error.')
    } finally {
      setFormBusy(false)
    }
  }

  // ── Toggle status ──────────────────────────────────────────────────────────

  async function handleToggle(entry: ConfigEntry) {
    if (entry.status === 'active') { setConfirmDisable(entry); return }
    await doToggle(entry.id, 'active')
  }

  async function doToggle(entryId: string, newStatus: 'active' | 'disabled') {
    setBusyId(entryId)
    setError(null)
    setSuccess(null)
    try {
      const token = await getAccessToken()
      if (!token) return
      const res = await fetch(`/api/admin/keys/${entryId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: newStatus }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Failed to update.'); return }
      setEntries(prev => prev.map(e => e.id === entryId ? { ...e, ...data.key } : e))
      setSuccess(`Key ${newStatus === 'active' ? 'enabled' : 'disabled'}.`)
    } catch {
      setError('Network error.')
    } finally {
      setBusyId(null)
      setConfirmDisable(null)
    }
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async function handleDelete(entryId: string) {
    setBusyId(entryId)
    setError(null)
    setSuccess(null)
    try {
      const token = await getAccessToken()
      if (!token) return
      const res = await fetch(`/api/admin/keys/${entryId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Failed to delete.'); return }
      setEntries(prev => prev.filter(e => e.id !== entryId))
      setSuccess('Key deleted.')
    } catch {
      setError('Network error.')
    } finally {
      setBusyId(null)
      setConfirmDelete(null)
    }
  }

  // ── Health check ─────────────────────────────────────────────────────────────

  async function handleHealthCheck() {
    setHealthBusy(true)
    setError(null)
    setSuccess(null)
    setHealthSummary(null)
    try {
      const token = await getAccessToken()
      if (!token) { setError('Not authenticated.'); return }
      const res = await fetch('/api/admin/keys/healthcheck', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Health check failed.'); return }
      if (Array.isArray(data.keys)) setEntries(data.keys as ConfigEntry[])
      setHealthSummary(data.summary as HealthSummary)
      setSuccess(
        `Health check complete — ${data.summary.healthy} healthy, ` +
        `${data.summary.unhealthy} unhealthy, ${data.summary.unknown} unknown.`,
      )
    } catch {
      setError('Network error running health check.')
    } finally {
      setHealthBusy(false)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) return <div style={{ padding: 32, color: '#888' }}>Loading…</div>
  if (forbidden) return <div style={{ padding: 32, color: '#dc2626' }}>Access denied — admins only.</div>

  const groupedEntries = CONFIG_KEYS.map(ck => ({
    configKey: ck.value,
    display:   ck.display,
    entries:   entries.filter(e => e.config_key === ck.value),
  }))

  return (
    <div style={{ padding: '28px 32px', maxWidth: 900 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>API Keys</h1>
      <p style={{ fontSize: 13, color: '#666', marginBottom: 28 }}>
        Keys are stored encrypted (AES-256-GCM). They cannot be viewed after saving.
        Env-var keys continue to work as fallback when no DB keys are active.
      </p>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '10px 14px', marginBottom: 20, color: '#dc2626', fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {error}
          <button onClick={() => setError(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontWeight: 700 }}>✕</button>
        </div>
      )}
      {success && (
        <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 6, padding: '10px 14px', marginBottom: 20, color: '#16a34a', fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {success}
          <button onClick={() => setSuccess(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#16a34a', fontWeight: 700 }}>✕</button>
        </div>
      )}

      {/* Health check bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '14px 18px', marginBottom: 28 }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#1e293b' }}>Key health</div>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
            Last checked: {fmtDate(latestCheckedAt(entries))}
            <span style={{ marginLeft: 8, color: '#94a3b8' }}>· runs automatically once a day</span>
          </div>
          {healthSummary && (
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
              {healthSummary.healthy} healthy · {healthSummary.unhealthy} unhealthy · {healthSummary.unknown} unknown
            </div>
          )}
        </div>
        <button
          onClick={handleHealthCheck}
          disabled={healthBusy}
          style={{ fontSize: 13, fontWeight: 600, padding: '8px 18px', borderRadius: 6, border: 'none', cursor: healthBusy ? 'default' : 'pointer', background: healthBusy ? '#93c5fd' : '#2563eb', color: '#fff', whiteSpace: 'nowrap' }}
        >
          {healthBusy ? 'Checking…' : 'Run health check now'}
        </button>
      </div>

      {/* Per-config-key tables */}
      {groupedEntries.map(({ configKey, display, entries: group }) => (
        <section key={configKey} style={{ marginBottom: 36 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>
            {display}
            <span style={{ marginLeft: 6, fontSize: 11, color: '#94a3b8', fontWeight: 400 }}>
              {configKey}
            </span>
            <span style={{ marginLeft: 10, fontSize: 12, color: '#888', fontWeight: 400 }}>
              — {group.filter(e => e.status === 'active').length} active
            </span>
          </h2>

          {group.length === 0 ? (
            <p style={{ fontSize: 13, color: '#999', paddingLeft: 4, marginTop: 8 }}>
              No DB keys — using env var fallback.
            </p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                  {['Label', 'Key', 'Status', 'Health', 'Last used', 'Actions'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '6px 10px', color: '#6b7280', fontWeight: 500, fontSize: 12 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {group.map(e => (
                  <tr key={e.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '10px 10px', fontWeight: 500 }}>{e.label}</td>
                    <td style={{ padding: '10px 10px', fontFamily: 'monospace', color: '#374151' }}>
                      ••••{e.last4}
                    </td>
                    <td style={{ padding: '10px 10px' }}>
                      <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, background: e.status === 'active' ? '#dcfce7' : '#f3f4f6', color: e.status === 'active' ? '#16a34a' : '#6b7280' }}>
                        {e.status}
                      </span>
                      {e.disabled_reason && (
                        <span style={{ marginLeft: 6, fontSize: 11, color: '#9ca3af' }}>({e.disabled_reason})</span>
                      )}
                    </td>
                    <td style={{ padding: '10px 10px' }}>
                      {e.health_status ? (
                        <span
                          title={`${e.health_detail ?? ''}${e.health_checked_at ? `\nChecked: ${fmtDate(e.health_checked_at)}` : ''}`}
                          style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, background: HEALTH_STYLE[e.health_status].bg, color: HEALTH_STYLE[e.health_status].fg, cursor: 'help' }}
                        >
                          {HEALTH_STYLE[e.health_status].label}
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, color: '#9ca3af' }}>Not checked</span>
                      )}
                    </td>
                    <td style={{ padding: '10px 10px', color: '#6b7280' }}>{fmtDate(e.last_used_at)}</td>
                    <td style={{ padding: '10px 10px' }}>
                      <button
                        onClick={() => handleToggle(e)}
                        disabled={busyId === e.id}
                        style={{ fontSize: 12, padding: '4px 10px', borderRadius: 4, cursor: 'pointer', border: '1px solid #d1d5db', background: '#fff', marginRight: 6, opacity: busyId === e.id ? 0.5 : 1 }}
                      >
                        {e.status === 'active' ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        onClick={() => setConfirmDelete(e)}
                        disabled={busyId === e.id}
                        style={{ fontSize: 12, padding: '4px 10px', borderRadius: 4, cursor: 'pointer', border: '1px solid #fca5a5', background: '#fff', color: '#dc2626', opacity: busyId === e.id ? 0.5 : 1 }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}

      {/* Add key form */}
      <section style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: 24 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Add a new key</h2>
        <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>
          Keys are write-only — they cannot be retrieved after saving.
        </p>

        {justAdded && (
          <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 6, padding: '10px 14px', marginBottom: 16, color: '#16a34a', fontSize: 13 }}>
            {justAdded}
          </div>
        )}
        {formError && (
          <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '10px 14px', marginBottom: 16, color: '#dc2626', fontSize: 13 }}>
            {formError}
          </div>
        )}

        <form onSubmit={handleAdd}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 3fr auto', gap: 10, alignItems: 'end' }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: '#374151', marginBottom: 4 }}>Provider</label>
              <select
                value={formConfigKey}
                onChange={e => setFormConfigKey(e.target.value as ConfigKeyValue)}
                disabled={formBusy}
                style={{ width: '100%', padding: '7px 10px', borderRadius: 5, border: '1px solid #d1d5db', fontSize: 13, background: '#fff' }}
              >
                {CONFIG_KEYS.map(ck => (
                  <option key={ck.value} value={ck.value}>{ck.display}</option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: '#374151', marginBottom: 4 }}>Label</label>
              <input
                type="text"
                value={formLabel}
                onChange={e => setFormLabel(e.target.value)}
                placeholder="e.g. prod-key-1"
                maxLength={80}
                required
                disabled={formBusy}
                style={{ width: '100%', padding: '7px 10px', borderRadius: 5, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: '#374151', marginBottom: 4 }}>
                API Key <span style={{ fontWeight: 400, color: '#9ca3af' }}>(write-only)</span>
              </label>
              <input
                type="password"
                value={formKey}
                onChange={e => setFormKey(e.target.value)}
                placeholder="Paste key here — it will not be shown again"
                required
                disabled={formBusy}
                autoComplete="off"
                style={{ width: '100%', padding: '7px 10px', borderRadius: 5, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }}
              />
            </div>

            <button
              type="submit"
              disabled={formBusy || !formLabel.trim() || !formKey.trim()}
              style={{ padding: '7px 18px', borderRadius: 5, fontSize: 13, fontWeight: 600, background: (formBusy || !formLabel.trim() || !formKey.trim()) ? '#d1d5db' : '#2563eb', color: '#fff', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              {formBusy ? 'Saving…' : 'Add key'}
            </button>
          </div>
        </form>
      </section>

      {/* Disable confirm */}
      {confirmDisable && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: 10, padding: 28, maxWidth: 420, width: '90%' }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>Disable key?</h3>
            <p style={{ fontSize: 13, color: '#555', marginBottom: 20 }}>
              &ldquo;{confirmDisable.label}&rdquo; (••••{confirmDisable.last4}) will be disabled immediately.
              You can re-enable it later.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmDisable(null)} style={{ padding: '7px 16px', borderRadius: 5, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={() => doToggle(confirmDisable.id, 'disabled')} disabled={busyId === confirmDisable.id} style={{ padding: '7px 16px', borderRadius: 5, background: '#f59e0b', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                {busyId === confirmDisable.id ? 'Disabling…' : 'Disable'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {confirmDelete && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: 10, padding: 28, maxWidth: 420, width: '90%' }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>Delete key?</h3>
            <p style={{ fontSize: 13, color: '#555', marginBottom: 20 }}>
              &ldquo;{confirmDelete.label}&rdquo; (••••{confirmDelete.last4}) will be permanently deleted.
              This cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmDelete(null)} style={{ padding: '7px 16px', borderRadius: 5, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={() => handleDelete(confirmDelete.id)} disabled={busyId === confirmDelete.id} style={{ padding: '7px 16px', borderRadius: 5, background: '#dc2626', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                {busyId === confirmDelete.id ? 'Deleting…' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
