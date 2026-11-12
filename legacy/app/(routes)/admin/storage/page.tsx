'use client'

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { getCurrentRole, getAccessToken } from '@/lib/supabase/auth'

// ── Types ─────────────────────────────────────────────────────────────────────

type MaskedConfig = {
  id: string
  created_at: string
  updated_at: string
  provider: string
  label: string
  account_id: string
  access_key_id: string
  bucket: string
  secret_last4: string
  status: 'active' | 'disabled'
  disabled_reason: string | null
  last_used_at: string | null
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function StoragePage() {
  const [loading, setLoading]     = useState(true)
  const [forbidden, setForbidden] = useState(false)
  const [configs, setConfigs]     = useState<MaskedConfig[]>([])
  const [error, setError]         = useState<string | null>(null)
  const [success, setSuccess]     = useState<string | null>(null)
  const [busyId, setBusyId]       = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<MaskedConfig | null>(null)

  // Add form
  const [label, setLabel]           = useState('')
  const [accountId, setAccountId]   = useState('')
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secret, setSecret]         = useState('')
  const [bucket, setBucket]         = useState('')
  const [formBusy, setFormBusy]     = useState(false)
  const [testing, setTesting]       = useState(false)
  const [formError, setFormError]   = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)

  const authFetch = useCallback(async (url: string, opts: RequestInit = {}) => {
    const token = await getAccessToken()
    return fetch(url, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}), Authorization: `Bearer ${token}` },
    })
  }, [])

  const load = useCallback(async () => {
    const res = await authFetch('/api/admin/storage')
    if (res.status === 403) { setForbidden(true); setLoading(false); return }
    const data = await res.json().catch(() => ({})) as { configs?: MaskedConfig[]; error?: string }
    if (!res.ok) { setError(data.error ?? 'Failed to load.'); setLoading(false); return }
    setConfigs(data.configs ?? [])
    setLoading(false)
  }, [authFetch])

  useEffect(() => {
    void (async () => {
      const role = await getCurrentRole()
      if (role !== 'admin') { setForbidden(true); setLoading(false); return }
      await load()
    })()
  }, [load])

  function credsBody() {
    return JSON.stringify({
      label: label.trim(),
      account_id: accountId.trim(),
      access_key_id: accessKeyId.trim(),
      secret_access_key: secret,
      bucket: bucket.trim(),
    })
  }

  async function handleTest() {
    setTesting(true); setTestResult(null); setFormError(null)
    try {
      const res = await authFetch('/api/admin/storage?test=1', { method: 'POST', body: credsBody() })
      const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string }
      if (res.ok && data.ok) setTestResult('✓ Connection succeeded — bucket reachable.')
      else setFormError(data.error ?? 'Connection test failed.')
    } catch { setFormError('Network error.') }
    finally { setTesting(false) }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setFormBusy(true); setFormError(null); setTestResult(null); setSuccess(null)
    try {
      const res = await authFetch('/api/admin/storage', { method: 'POST', body: credsBody() })
      const data = await res.json().catch(() => ({})) as { config?: MaskedConfig; error?: string }
      if (!res.ok) { setFormError(data.error ?? 'Failed to save.'); return }
      setSuccess('Storage config saved. Secret cannot be viewed again.')
      setLabel(''); setAccountId(''); setAccessKeyId(''); setSecret(''); setBucket('')
      await load()
    } catch { setFormError('Network error.') }
    finally { setFormBusy(false) }
  }

  async function handleToggle(c: MaskedConfig) {
    setBusyId(c.id); setError(null); setSuccess(null)
    const next = c.status === 'active' ? 'disabled' : 'active'
    try {
      const res = await authFetch(`/api/admin/storage/${c.id}`, {
        method: 'PATCH', body: JSON.stringify({ status: next }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); setError((d as { error?: string }).error ?? 'Failed.'); return }
      await load()
    } catch { setError('Network error.') }
    finally { setBusyId(null) }
  }

  async function handleDelete(c: MaskedConfig) {
    setBusyId(c.id); setError(null)
    try {
      const res = await authFetch(`/api/admin/storage/${c.id}`, { method: 'DELETE' })
      if (!res.ok) { const d = await res.json().catch(() => ({})); setError((d as { error?: string }).error ?? 'Failed.'); return }
      await load()
    } catch { setError('Network error.') }
    finally { setBusyId(null); setConfirmDelete(null) }
  }

  if (loading) return <div style={{ padding: 32, color: '#888' }}>Loading…</div>
  if (forbidden) return <div style={{ padding: 32, color: '#dc2626' }}>Access denied — admins only.</div>

  return (
    <div style={{ padding: '28px 32px', maxWidth: 900 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Object Storage</h1>
      <p style={{ fontSize: 13, color: '#666', marginBottom: 24 }}>
        Cloudflare R2 credentials for audio storage. The secret access key is stored
        encrypted (AES-256-GCM) and cannot be viewed after saving. An active config is
        required — audio storage does not work until one is added here.
      </p>

      {error && <Banner kind="error" onClose={() => setError(null)}>{error}</Banner>}
      {success && <Banner kind="ok" onClose={() => setSuccess(null)}>{success}</Banner>}

      {/* Existing configs */}
      <section style={{ marginBottom: 32 }}>
        {configs.length === 0 ? (
          <p style={{ fontSize: 13, color: '#999' }}>No storage config yet — add one below to enable audio storage.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                {['Label', 'Bucket', 'Account', 'Access key', 'Secret', 'Status', 'Actions'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '6px 10px', color: '#6b7280', fontWeight: 500, fontSize: 12 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {configs.map(c => (
                <tr key={c.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '10px', fontWeight: 500 }}>{c.label}</td>
                  <td style={{ padding: '10px', fontFamily: 'monospace' }}>{c.bucket}</td>
                  <td style={{ padding: '10px', fontFamily: 'monospace', color: '#6b7280' }}>{c.account_id.slice(0, 8)}…</td>
                  <td style={{ padding: '10px', fontFamily: 'monospace', color: '#6b7280' }}>{c.access_key_id.slice(0, 6)}…</td>
                  <td style={{ padding: '10px', fontFamily: 'monospace', color: '#374151' }}>••••{c.secret_last4}</td>
                  <td style={{ padding: '10px' }}>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, background: c.status === 'active' ? '#dcfce7' : '#f3f4f6', color: c.status === 'active' ? '#16a34a' : '#6b7280' }}>{c.status}</span>
                  </td>
                  <td style={{ padding: '10px' }}>
                    <button onClick={() => handleToggle(c)} disabled={busyId === c.id}
                      style={{ fontSize: 12, padding: '4px 10px', borderRadius: 4, cursor: 'pointer', border: '1px solid #d1d5db', background: '#fff', marginRight: 6 }}>
                      {c.status === 'active' ? 'Disable' : 'Enable'}
                    </button>
                    <button onClick={() => setConfirmDelete(c)} disabled={busyId === c.id}
                      style={{ fontSize: 12, padding: '4px 10px', borderRadius: 4, cursor: 'pointer', border: '1px solid #fca5a5', background: '#fff', color: '#dc2626' }}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Add form */}
      <section style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: 24 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Add R2 configuration</h2>
        <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>The secret access key is write-only — it cannot be retrieved after saving.</p>

        {formError && <Banner kind="error">{formError}</Banner>}
        {testResult && <Banner kind="ok">{testResult}</Banner>}

        <form onSubmit={handleSave}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <Field label="Label" value={label} onChange={setLabel} placeholder="e.g. production-r2" disabled={formBusy} />
            <Field label="Bucket" value={bucket} onChange={setBucket} placeholder="recordings" disabled={formBusy} />
            <Field label="Account ID" value={accountId} onChange={setAccountId} placeholder="Cloudflare account id" disabled={formBusy} />
            <Field label="Access Key ID" value={accessKeyId} onChange={setAccessKeyId} placeholder="R2 access key id" disabled={formBusy} />
            <Field label="Secret Access Key (write-only)" value={secret} onChange={setSecret} placeholder="R2 secret access key" type="password" disabled={formBusy} />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" onClick={handleTest} disabled={testing || formBusy}
              style={{ fontSize: 13, padding: '8px 16px', borderRadius: 6, cursor: 'pointer', border: '1px solid #d1d5db', background: '#fff', fontWeight: 600 }}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <button type="submit" disabled={formBusy}
              style={{ fontSize: 13, padding: '8px 16px', borderRadius: 6, cursor: 'pointer', border: 'none', background: '#3b82f6', color: '#fff', fontWeight: 700, opacity: formBusy ? 0.6 : 1 }}>
              {formBusy ? 'Saving…' : 'Test & Save'}
            </button>
          </div>
          <p style={{ fontSize: 11.5, color: '#9ca3af', marginTop: 10 }}>Save runs a connection test first and refuses to persist invalid credentials.</p>
        </form>
      </section>

      {/* Delete confirm */}
      {confirmDelete && (
        <div onClick={() => setConfirmDelete(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 10, padding: 24, maxWidth: 400 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Delete storage config?</h3>
            <p style={{ fontSize: 13, color: '#555', marginBottom: 18 }}>
              &ldquo;{confirmDelete.label}&rdquo; will be permanently removed. If it was the active
              config, audio storage stops working until another active config is added.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={() => setConfirmDelete(null)} style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>Cancel</button>
              <button onClick={() => handleDelete(confirmDelete)} style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: '#dc2626', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Small components ────────────────────────────────────────────────────────────

function Field({ label, value, onChange, placeholder, type = 'text', disabled }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; disabled?: boolean
}) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: '#374151', marginBottom: 4 }}>{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} disabled={disabled} required
        style={{ width: '100%', padding: '7px 10px', borderRadius: 5, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }} />
    </div>
  )
}

function Banner({ kind, children, onClose }: { kind: 'ok' | 'error'; children: React.ReactNode; onClose?: () => void }) {
  const s: CSSProperties = kind === 'ok'
    ? { background: '#f0fdf4', border: '1px solid #86efac', color: '#16a34a' }
    : { background: '#fef2f2', border: '1px solid #fca5a5', color: '#dc2626' }
  return (
    <div style={{ ...s, borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span>{children}</span>
      {onClose && <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontWeight: 700 }}>✕</button>}
    </div>
  )
}
