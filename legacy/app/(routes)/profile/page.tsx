'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { browserClient } from '@/lib/supabase/browser'
import { signOut } from '@/lib/supabase/auth'
import { useTheme } from '@/hooks/useTheme'
import { THEMES, type Theme } from '@/lib/theme'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProfileData {
  id: string
  email: string | null
  username: string
  display_name: string | null
  avatar_key: string | null
  avatar_url: string | null
  theme_preference: Theme | null
  role: 'user' | 'admin'
  created_at: string
  meeting_count: number
  folder_count: number
  audio_seconds_remaining: number
  agent_queries_remaining: number
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

async function authFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const { data: { session } } = await browserClient.auth.getSession()
  const token = session?.access_token ?? ''
  return fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token}`,
    },
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInitials(display_name: string | null, username: string): string {
  const name = display_name?.trim() || username
  const words = name.split(/\s+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

function formatMemberSince(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

const FONT = 'var(--t-font-body)'
const PRIMARY = 'rgb(var(--t-primary-rgb))'
const FG = 'rgb(var(--t-fg-rgb))'
const BG = 'rgb(var(--t-bg-rgb))'
const BORDER = 'rgb(var(--t-border-rgb))'
const MUTED = 'rgb(var(--t-fg-rgb) / 0.45)'
const LABEL = 'rgb(var(--t-fg-rgb) / 0.55)'
const INPUT_BG = 'rgb(var(--t-fg-rgb) / 0.02)'

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <section style={{
      background: BG,
      border: `1px solid ${BORDER}`,
      borderRadius: 'var(--t-radius-card)',
      padding: '22px 24px',
      ...style,
    }}>
      {children}
    </section>
  )
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 15, fontWeight: 700, color: FG, fontFamily: FONT }}>{children}</div>
  )
}

function CardDivider() {
  return <div style={{ height: 1, background: BORDER, margin: '16px 0 18px' }} />
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', fontSize: 12.5, fontWeight: 700, color: LABEL, marginBottom: 7, fontFamily: FONT }}>
      {children}
    </label>
  )
}

function EyeIcon({ visible }: { visible: boolean }) {
  return visible ? (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  )
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  readOnly,
  required,
  minLength,
  maxLength,
  autoComplete,
}: {
  value: string
  onChange?: (v: string) => void
  placeholder?: string
  type?: string
  readOnly?: boolean
  required?: boolean
  minLength?: number
  maxLength?: number
  autoComplete?: string
}) {
  const [focused, setFocused] = useState(false)
  const [showPw, setShowPw] = useState(false)
  const isPassword = type === 'password'

  const inputEl = (
    <input
      type={isPassword ? (showPw ? 'text' : 'password') : type}
      value={value}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      readOnly={readOnly}
      placeholder={placeholder}
      required={required}
      minLength={minLength}
      maxLength={maxLength}
      autoComplete={autoComplete}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        width: '100%',
        padding: isPassword ? '11px 42px 11px 14px' : '11px 14px',
        borderRadius: 'var(--t-radius-input)',
        border: focused ? `1px solid ${PRIMARY}` : `1px solid ${BORDER}`,
        background: readOnly ? 'rgb(var(--t-fg-rgb) / 0.04)' : INPUT_BG,
        fontFamily: FONT,
        fontSize: 14,
        fontWeight: 500,
        color: readOnly ? MUTED : FG,
        outline: 'none',
        boxSizing: 'border-box',
        boxShadow: focused ? `0 0 0 3px rgb(var(--t-primary-rgb) / 0.14)` : 'none',
        transition: 'border-color .15s, box-shadow .15s',
      }}
    />
  )

  if (!isPassword) return inputEl

  return (
    <div style={{ position: 'relative' }}>
      {inputEl}
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShowPw((v) => !v)}
        aria-label={showPw ? 'Hide password' : 'Show password'}
        style={{
          position: 'absolute',
          right: 12,
          top: '50%',
          transform: 'translateY(-50%)',
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          color: MUTED,
          display: 'flex',
          alignItems: 'center',
          lineHeight: 0,
        }}
      >
        <EyeIcon visible={showPw} />
      </button>
    </div>
  )
}

function PrimaryBtn({
  children,
  onClick,
  disabled,
  type = 'button',
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '10px 18px',
        borderRadius: 'var(--t-radius-btn)',
        border: 'none',
        background: `linear-gradient(135deg, rgb(var(--t-primary-rgb) / 0.9), rgb(var(--t-primary-rgb)))`,
        cursor: disabled ? 'default' : 'pointer',
        fontFamily: FONT,
        fontSize: 13.5,
        fontWeight: 700,
        color: '#fff',
        boxShadow: `0 6px 16px rgb(var(--t-primary-rgb) / 0.28)`,
        opacity: disabled ? 0.65 : 1,
        transition: 'opacity .15s, box-shadow .15s',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  )
}

function SecondaryBtn({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '9px 15px',
        borderRadius: 10,
        border: `1px solid ${BORDER}`,
        background: BG,
        cursor: disabled ? 'default' : 'pointer',
        fontFamily: FONT,
        fontSize: 13,
        fontWeight: 700,
        color: FG,
        opacity: disabled ? 0.65 : 1,
      }}
    >
      {children}
    </button>
  )
}

function ErrorMsg({ msg, onDismiss }: { msg: string; onDismiss: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, background: '#fdeef0', border: '1px solid #f9c6cc', borderRadius: 10, padding: '9px 14px', fontSize: 13, color: '#c0202e', fontWeight: 600, fontFamily: FONT }}>
      <span>{msg}</span>
      <button onClick={onDismiss} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#c0202e', fontSize: 16, lineHeight: 1, padding: 0 }}>✕</button>
    </div>
  )
}

function SuccessMsg({ msg, onDismiss }: { msg: string; onDismiss: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, background: '#e3f6ed', border: '1px solid #b7e6d2', borderRadius: 10, padding: '9px 14px', fontSize: 13, color: '#147a50', fontWeight: 600, fontFamily: FONT }}>
      <span>{msg}</span>
      <button onClick={onDismiss} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#147a50', fontSize: 16, lineHeight: 1, padding: 0 }}>✕</button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Toggle switch
// ---------------------------------------------------------------------------

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        width: 46, height: 27,
        flexShrink: 0,
        borderRadius: 999,
        border: 'none',
        background: on ? PRIMARY : 'rgb(var(--t-fg-rgb) / 0.2)',
        cursor: 'pointer',
        padding: 0,
        position: 'relative',
        transition: 'background .15s',
      }}
    >
      <span style={{
        position: 'absolute',
        top: 3,
        left: on ? 22 : 3,
        width: 21, height: 21,
        borderRadius: '50%',
        background: '#fff',
        boxShadow: '0 1px 3px rgba(0,0,0,0.22)',
        transition: 'left .15s',
      }} />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_BYTES = 2 * 1024 * 1024

function AvatarCircle({
  size,
  initials,
  avatarUrl,
  loading,
}: {
  size: number
  initials: string
  avatarUrl: string | null
  loading: boolean
}) {
  return (
    <div style={{
      width: size, height: size,
      borderRadius: '50%',
      flexShrink: 0,
      overflow: 'hidden',
      background: `linear-gradient(135deg, rgb(var(--t-secondary-rgb, var(--t-primary-rgb))), rgb(var(--t-primary-rgb)))`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      position: 'relative',
    }}>
      {avatarUrl
        ? <img src={avatarUrl} alt="avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : <span style={{ fontSize: size * 0.38, fontWeight: 700, color: '#fff', fontFamily: FONT, letterSpacing: '-0.02em' }}>{initials}</span>
      }
      {loading && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(255,255,255,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: 11, color: PRIMARY }}>…</span>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ProfilePage() {
  const router = useRouter()
  const { theme: currentTheme, setTheme } = useTheme()
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Data ──────────────────────────────────────────────────────────────────
  const [profile, setProfile] = useState<ProfileData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // ── Identity ──────────────────────────────────────────────────────────────
  const [displayName, setDisplayName] = useState('')
  const [username, setUsername] = useState('')
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [profileSuccess, setProfileSuccess] = useState<string | null>(null)

  // ── Password ──────────────────────────────────────────────────────────────
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [pwSaving, setPwSaving] = useState(false)
  const [pwError, setPwError] = useState<string | null>(null)
  const [pwSuccess, setPwSuccess] = useState<string | null>(null)

  // ── Avatar ────────────────────────────────────────────────────────────────
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [avatarSaving, setAvatarSaving] = useState(false)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const [confirmRemoveAvatar, setConfirmRemoveAvatar] = useState(false)

  // ── Model preference (PRF-08) ─────────────────────────────────────────────
  const [modelPick, setModelPick]         = useState<string>('') // "provider:model" or "" = system default
  const [allowedModels, setAllowedModels] = useState<Array<{ provider: string; model: string; label: string }>>([])
  const [modelSaving, setModelSaving]     = useState(false)
  const [modelError, setModelError]       = useState<string | null>(null)
  const [modelSuccess, setModelSuccess]   = useState<string | null>(null)

  // ── Notifications (local state only — PRF-10 deferred) ────────────────────
  const [notif, setNotif] = useState({ summaries: true, shares: true, updates: false })

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      try {
        const res = await authFetch('/api/profile')
        if (!res.ok) {
          const j = await res.json().catch(() => ({}))
          setLoadError((j as { error?: string }).error ?? 'Failed to load profile.')
          return
        }
        const data: ProfileData = await res.json()
        setProfile(data)
        setDisplayName(data.display_name ?? '')
        setUsername(data.username)
        setAvatarUrl(data.avatar_url)
        if (data.theme_preference && data.theme_preference !== currentTheme) {
          setTheme(data.theme_preference)
        }

        // Load model preference in parallel (non-blocking)
        authFetch('/api/profile/preferences').then(async (prefRes) => {
          if (!prefRes.ok) return
          const pref = await prefRes.json() as { provider: string | null; model: string | null; allowedModels: Array<{ provider: string; model: string; label: string }> }
          setAllowedModels(pref.allowedModels)
          setModelPick(pref.provider && pref.model ? `${pref.provider}:${pref.model}` : '')
        }).catch(() => {})
      } catch {
        setLoadError('Failed to load profile.')
      } finally {
        setLoading(false)
      }
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Profile save ──────────────────────────────────────────────────────────
  async function handleProfileSave(e: React.FormEvent) {
    e.preventDefault()
    setProfileError(null); setProfileSuccess(null)
    setProfileSaving(true)
    try {
      const res = await authFetch('/api/profile', {
        method: 'PATCH',
        body: JSON.stringify({ username: username.trim().toLowerCase(), display_name: displayName.trim() || null }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setProfileError((j as { error?: string }).error ?? 'Failed to save.'); return }
      setProfile((p) => p ? { ...p, username: username.trim().toLowerCase(), display_name: displayName.trim() || null } : p)
      setProfileSuccess('Profile saved.')
    } catch { setProfileError('Network error.') }
    finally { setProfileSaving(false) }
  }

  // ── Password change ───────────────────────────────────────────────────────
  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault()
    setPwError(null); setPwSuccess(null)
    if (newPw !== confirmPw) { setPwError('New passwords do not match.'); return }
    if (newPw.length < 8) { setPwError('Password must be at least 8 characters.'); return }
    setPwSaving(true)
    try {
      const res = await authFetch('/api/profile/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setPwError((j as { error?: string }).error ?? 'Failed to update password.'); return }
      setPwSuccess('Password updated.')
      setCurrentPw(''); setNewPw(''); setConfirmPw('')
    } catch { setPwError('Network error.') }
    finally { setPwSaving(false) }
  }

  // ── Avatar upload ─────────────────────────────────────────────────────────
  async function handleAvatarFile(file: File) {
    setAvatarError(null)
    if (!ALLOWED_TYPES.includes(file.type)) { setAvatarError('Only JPEG, PNG, or WebP images.'); return }
    if (file.size > MAX_BYTES) { setAvatarError('Image must be under 2 MB.'); return }
    setAvatarSaving(true)
    try {
      const urlRes = await authFetch('/api/profile/avatar', { method: 'POST', body: JSON.stringify({ contentType: file.type, size: file.size }) })
      const urlJson = await urlRes.json().catch(() => ({}))
      if (!urlRes.ok) { setAvatarError((urlJson as { error?: string }).error ?? 'Upload failed.'); return }
      const { uploadUrl, avatarKey } = urlJson as { uploadUrl: string; avatarKey: string }
      const putRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })
      if (!putRes.ok) { setAvatarError('Storage upload failed.'); return }
      const confirmRes = await authFetch('/api/profile', { method: 'PATCH', body: JSON.stringify({ avatar_key: avatarKey }) })
      if (!confirmRes.ok) { setAvatarError('Failed to save avatar.'); return }
      const refreshed = await authFetch('/api/profile')
      if (refreshed.ok) {
        const data: ProfileData = await refreshed.json()
        setAvatarUrl(data.avatar_url)
        setProfile((p) => p ? { ...p, avatar_key: data.avatar_key, avatar_url: data.avatar_url } : p)
      }
    } catch { setAvatarError('Upload failed.') }
    finally { setAvatarSaving(false) }
  }

  async function handleAvatarRemove() {
    setAvatarError(null); setAvatarSaving(true)
    try {
      const res = await authFetch('/api/profile', { method: 'PATCH', body: JSON.stringify({ avatar_key: null }) })
      if (!res.ok) { const j = await res.json().catch(() => ({})); setAvatarError((j as { error?: string }).error ?? 'Failed to remove.'); return }
      setAvatarUrl(null)
      setProfile((p) => p ? { ...p, avatar_key: null, avatar_url: null } : p)
      setConfirmRemoveAvatar(false)
    } catch { setAvatarError('Network error.') }
    finally { setAvatarSaving(false) }
  }

  // ── Model preference ─────────────────────────────────────────────────────
  async function handleModelPrefSave() {
    setModelError(null); setModelSuccess(null); setModelSaving(true)
    try {
      const [provider, ...rest] = modelPick ? modelPick.split(':') : [null]
      const model = modelPick ? rest.join(':') : null
      const res = await authFetch('/api/profile/preferences', {
        method: 'PATCH',
        body: JSON.stringify({ provider: provider ?? null, model: model ?? null }),
      })
      const j = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) { setModelError(j.error ?? 'Failed to save.'); return }
      setModelSuccess('Saved.')
      setTimeout(() => setModelSuccess(null), 3000)
    } catch { setModelError('Network error.') }
    finally { setModelSaving(false) }
  }

  // ── Theme ─────────────────────────────────────────────────────────────────
  async function handleThemeChange(next: Theme) {
    setTheme(next)
    try {
      await authFetch('/api/profile', { method: 'PATCH', body: JSON.stringify({ theme_preference: next }) })
      setProfile((p) => p ? { ...p, theme_preference: next } : p)
    } catch { /* non-fatal */ }
  }

  // ── Sign out ──────────────────────────────────────────────────────────────
  async function handleSignOut() {
    await signOut()
    router.replace('/login')
  }

  // ── Loading / error ───────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgb(var(--t-fg-rgb) / 0.03)' }}>
        <span style={{ fontSize: 13, fontFamily: FONT, fontWeight: 600, color: PRIMARY, letterSpacing: '0.08em', textTransform: 'uppercase', animation: 'pulse 1.5s ease-in-out infinite' }}>Loading…</span>
      </div>
    )
  }

  if (loadError || !profile) {
    return (
      <div style={{ maxWidth: 520, margin: '0 auto', padding: '80px 24px', textAlign: 'center' }}>
        <p style={{ fontFamily: FONT, color: '#c0202e', fontSize: 14 }}>{loadError ?? 'Profile not found.'}</p>
      </div>
    )
  }

  const initials = getInitials(profile.display_name, profile.username)

  // Disable the save buttons until there's something to save.
  const profileDirty =
    displayName.trim() !== (profile.display_name ?? '') ||
    username.trim().toLowerCase() !== profile.username
  const passwordFilled = currentPw !== '' && newPw !== '' && confirmPw !== ''

  return (
    <div style={{ minHeight: '100vh', background: 'rgb(var(--t-fg-rgb) / 0.03)', fontFamily: FONT }}>
      <main style={{ maxWidth: 760, margin: '0 auto', padding: '28px 28px 90px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Back link */}
        <Link
          href="/meetings"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 12px 7px 9px', marginBottom: 2, borderRadius: 10, border: `1px solid ${BORDER}`, background: BG, fontSize: 13, fontWeight: 600, color: LABEL, textDecoration: 'none', width: 'fit-content' }}
        >
          <span style={{ fontSize: 15, lineHeight: 0 }}>‹</span> Back to meetings
        </Link>

        {/* Page heading */}
        <div style={{ marginBottom: 8 }}>
          <h1 style={{ margin: 0, fontSize: 30, fontWeight: 800, letterSpacing: '-0.025em', color: FG, fontFamily: FONT }}>
            Account <em style={{ fontStyle: 'italic', color: 'rgb(var(--t-terra-rgb))' }}>settings</em>
          </h1>
          <p style={{ margin: '8px 0 0', fontSize: 13.5, fontWeight: 500, color: MUTED }}>
            Manage your profile, preferences and notifications.
          </p>
        </div>

        {/* ── PROFILE ──────────────────────────────────────────────────────── */}
        <Card>
          <CardTitle>Profile</CardTitle>
          <CardDivider />

          {/* Avatar row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
            <AvatarCircle size={62} initials={initials} avatarUrl={avatarUrl} loading={avatarSaving} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                style={{ display: 'none' }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleAvatarFile(f); e.target.value = '' }}
              />
              <SecondaryBtn onClick={() => fileInputRef.current?.click()} disabled={avatarSaving}>
                {avatarUrl ? 'Change photo' : 'Upload photo'}
              </SecondaryBtn>
              {avatarUrl && (
                <button
                  type="button"
                  disabled={avatarSaving}
                  onClick={() => { setAvatarError(null); setConfirmRemoveAvatar(true) }}
                  style={{ padding: '9px 12px', borderRadius: 10, border: 'none', background: 'transparent', cursor: avatarSaving ? 'default' : 'pointer', fontFamily: FONT, fontSize: 13, fontWeight: 600, color: MUTED, opacity: avatarSaving ? 0.5 : 1 }}
                  onMouseEnter={(e) => { if (!avatarSaving) (e.currentTarget as HTMLButtonElement).style.color = '#ef5a6f' }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = MUTED }}
                >
                  Remove
                </button>
              )}
            </div>
          </div>

          {avatarError && <div style={{ marginBottom: 16 }}><ErrorMsg msg={avatarError} onDismiss={() => setAvatarError(null)} /></div>}

          {/* Identity fields */}
          <form onSubmit={(e) => { void handleProfileSave(e) }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <FieldLabel>Display name</FieldLabel>
                <TextInput
                  value={displayName}
                  onChange={setDisplayName}
                  placeholder="How others see you"
                  maxLength={50}
                />
              </div>
              <div>
                <FieldLabel>Username</FieldLabel>
                <TextInput
                  value={username}
                  onChange={(v) => setUsername(v.toLowerCase())}
                  placeholder="@username"
                  minLength={3}
                  maxLength={30}
                  required
                />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <FieldLabel>Email address</FieldLabel>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <TextInput value={profile.email ?? ''} readOnly />
                  <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 800, letterSpacing: '0.04em', color: 'rgb(var(--t-terra-rgb))', background: 'rgb(var(--t-terra-rgb) / 0.12)', borderRadius: 8, padding: '7px 11px', fontFamily: FONT }}>
                    VERIFIED
                  </span>
                </div>
              </div>
            </div>

            {profileError && <div style={{ marginTop: 14 }}><ErrorMsg msg={profileError} onDismiss={() => setProfileError(null)} /></div>}
            {profileSuccess && <div style={{ marginTop: 14 }}><SuccessMsg msg={profileSuccess} onDismiss={() => setProfileSuccess(null)} /></div>}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <PrimaryBtn type="submit" disabled={profileSaving || !profileDirty}>
                {profileSaving ? 'Saving…' : 'Save profile'}
              </PrimaryBtn>
            </div>
          </form>
        </Card>

        {/* ── ACCOUNT (read-only overview) ─────────────────────────────────── */}
        <Card>
          <CardTitle>Account</CardTitle>
          <CardDivider />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '14px 24px' }}>
            {[
              { label: 'Role', value: (
                <span style={{ fontSize: 13, fontWeight: 700, color: PRIMARY, background: `rgb(var(--t-primary-rgb) / 0.1)`, borderRadius: 7, padding: '3px 9px', fontFamily: FONT }}>
                  {profile.role === 'admin' ? 'Admin' : 'Member'}
                </span>
              )},
              { label: 'Member since', value: formatMemberSince(profile.created_at) },
              { label: 'Recordings', value: profile.meeting_count },
              { label: 'Folders', value: profile.folder_count },
              { label: 'Audio balance', value: `${Math.max(0, Math.floor(profile.audio_seconds_remaining / 60))} min` },
              { label: 'Agent queries', value: Math.max(0, profile.agent_queries_remaining).toString() },
            ].map(({ label, value }) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '11px 14px', borderRadius: 'var(--t-radius-input)', background: 'rgb(var(--t-fg-rgb) / 0.02)', border: `1px solid ${BORDER}` }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: MUTED, fontFamily: FONT }}>{label}</span>
                {typeof value === 'object'
                  ? value
                  : <span style={{ fontSize: 13.5, fontWeight: 600, color: FG, fontFamily: FONT }}>{value}</span>
                }
              </div>
            ))}
          </div>
        </Card>

        {/* ── LOW BALANCE WARNING ───────────────────────────────────────────── */}
        {(profile.audio_seconds_remaining <= 0 || profile.agent_queries_remaining <= 0) && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 16px', borderRadius: 'var(--t-radius-card)', background: '#fffbeb', border: '1px solid #fde68a', fontFamily: FONT }}>
            <span style={{ fontSize: 18, lineHeight: 1.2, flexShrink: 0 }}>⚠</span>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: '#92400e', marginBottom: 2 }}>Balance low</div>
              <div style={{ fontSize: 12.5, fontWeight: 500, color: '#b45309', lineHeight: 1.5 }}>
                {profile.audio_seconds_remaining <= 0 && profile.agent_queries_remaining <= 0
                  ? 'You have no audio minutes or agent queries remaining.'
                  : profile.audio_seconds_remaining <= 0
                    ? 'You have no audio minutes remaining — new recordings cannot be processed.'
                    : 'You have no agent queries remaining — the chat assistant is unavailable.'}
                {' '}Contact your admin to top up your balance.
              </div>
            </div>
          </div>
        )}

        {/* ── PASSWORD ─────────────────────────────────────────────────────── */}
        <Card>
          <CardTitle>Password</CardTitle>
          <CardDivider />
          <form onSubmit={(e) => { void handlePasswordChange(e) }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
              <div style={{ gridColumn: '1 / -1' }}>
                <FieldLabel>Current password</FieldLabel>
                <TextInput value={currentPw} onChange={setCurrentPw} type="password" placeholder="••••••••" required autoComplete="current-password" />
              </div>
              <div>
                <FieldLabel>New password</FieldLabel>
                <TextInput value={newPw} onChange={setNewPw} type="password" placeholder="••••••••" required minLength={8} autoComplete="new-password" />
              </div>
              <div>
                <FieldLabel>Confirm new password</FieldLabel>
                <TextInput value={confirmPw} onChange={setConfirmPw} type="password" placeholder="••••••••" required autoComplete="new-password" />
              </div>
            </div>

            {pwError && <div style={{ marginTop: 14 }}><ErrorMsg msg={pwError} onDismiss={() => setPwError(null)} /></div>}
            {pwSuccess && <div style={{ marginTop: 14 }}><SuccessMsg msg={pwSuccess} onDismiss={() => setPwSuccess(null)} /></div>}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 16 }}>
              <span style={{ fontSize: 12, fontWeight: 500, color: MUTED, fontFamily: FONT }}>Use at least 8 characters.</span>
              <PrimaryBtn type="submit" disabled={pwSaving || !passwordFilled}>
                {pwSaving ? 'Updating…' : 'Update password'}
              </PrimaryBtn>
            </div>
          </form>
        </Card>

        {/* ── PREFERENCES ──────────────────────────────────────────────────── */}
        <Card>
          <CardTitle>Preferences</CardTitle>
          <CardDivider />

          {/* Appearance — temporarily hidden
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: FG, fontFamily: FONT }}>Appearance</div>
              <div style={{ fontSize: 12.5, fontWeight: 500, color: MUTED, marginTop: 2, fontFamily: FONT }}>Choose how Ricotdin looks.</div>
            </div>
            <div style={{ display: 'flex', background: 'rgb(var(--t-fg-rgb) / 0.06)', padding: 4, borderRadius: 'var(--t-radius-input)', gap: 4, flexShrink: 0 }}>
              {THEMES.map((t) => {
                const active = currentTheme === t.id
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => { void handleThemeChange(t.id) }}
                    style={{
                      padding: '8px 14px',
                      borderRadius: 8,
                      border: 'none',
                      background: active ? BG : 'transparent',
                      cursor: 'pointer',
                      fontFamily: FONT,
                      fontSize: 13,
                      fontWeight: active ? 700 : 600,
                      color: active ? FG : LABEL,
                      boxShadow: active ? '0 1px 3px rgba(0,0,0,0.13)' : 'none',
                      transition: 'background .15s, color .15s',
                    }}
                  >
                    {t.label}
                  </button>
                )
              })}
            </div>
          </div>
          */}

          {/* Language (deferred) */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: allowedModels.length > 0 ? 20 : 0 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: FG, fontFamily: FONT }}>Language</div>
              <div style={{ fontSize: 12.5, fontWeight: 500, color: MUTED, marginTop: 2, fontFamily: FONT }}>Used across menus and email.</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 14px', borderRadius: 'var(--t-radius-input)', border: `1px solid ${BORDER}`, background: INPUT_BG, fontSize: 13.5, fontWeight: 600, color: MUTED, fontFamily: FONT, cursor: 'not-allowed', userSelect: 'none' }}>
              English (US) <span style={{ color: MUTED, fontSize: 10, marginLeft: 4 }}>▾</span>
            </div>
          </div>

          {/* AI Model default (PRF-08) — shown only when allow-list has > 1 option */}
          {allowedModels.length > 1 && (
            <>
              <div style={{ height: 1, background: BORDER, marginBottom: 20 }} />
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: FG, fontFamily: FONT }}>AI model</div>
                  <div style={{ fontSize: 12.5, fontWeight: 500, color: MUTED, marginTop: 2, fontFamily: FONT }}>Default model used when processing your recordings.</div>
                  {modelError   && <div style={{ fontSize: 12, color: '#c0415a', marginTop: 6 }}>{modelError}</div>}
                  {modelSuccess && <div style={{ fontSize: 12, color: '#2a7a4e', marginTop: 6 }}>{modelSuccess}</div>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0 }}>
                  <select
                    value={modelPick}
                    onChange={(e) => setModelPick(e.target.value)}
                    style={{ padding: '10px 14px', borderRadius: 'var(--t-radius-input)', border: `1px solid ${BORDER}`, background: INPUT_BG, fontSize: 13.5, fontWeight: 600, color: FG, fontFamily: FONT, cursor: 'pointer' }}
                  >
                    <option value="">System default (auto)</option>
                    {allowedModels.map((m) => (
                      <option key={`${m.provider}:${m.model}`} value={`${m.provider}:${m.model}`}>{m.label}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => { void handleModelPrefSave() }}
                    disabled={modelSaving}
                    style={{ padding: '10px 18px', borderRadius: 'var(--t-radius-input)', border: `1px solid ${BORDER}`, background: BG, cursor: modelSaving ? 'not-allowed' : 'pointer', fontFamily: FONT, fontSize: 13.5, fontWeight: 700, color: FG, opacity: modelSaving ? 0.6 : 1 }}
                  >
                    {modelSaving ? '…' : 'Save'}
                  </button>
                </div>
              </div>
            </>
          )}
        </Card>

        {/* ── NOTIFICATIONS (PRF-10 deferred — local state only) ────────────── */}
        <Card>
          <CardTitle>Notifications</CardTitle>
          <div style={{ height: 1, background: BORDER, margin: '16px 0 6px' }} />

          {[
            { key: 'summaries' as const, label: 'Meeting summaries', desc: 'Email me a recap when a recording finishes processing.' },
            { key: 'shares' as const, label: 'Shares & mentions', desc: 'Notify me when someone shares a folder or mentions me.' },
            { key: 'updates' as const, label: 'Product updates', desc: 'Occasional news about new Ricotdin features.' },
          ].map(({ key, label, desc }, i, arr) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '14px 0', borderBottom: i < arr.length - 1 ? `1px solid rgb(var(--t-fg-rgb) / 0.06)` : 'none' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: FG, fontFamily: FONT }}>{label}</div>
                <div style={{ fontSize: 12.5, fontWeight: 500, color: MUTED, marginTop: 2, fontFamily: FONT }}>{desc}</div>
              </div>
              <Toggle on={notif[key]} onToggle={() => setNotif((n) => ({ ...n, [key]: !n[key] }))} />
            </div>
          ))}
        </Card>

        {/* ── SESSION ──────────────────────────────────────────────────────── */}
        <Card>
          <CardTitle>Session</CardTitle>
          <CardDivider />

          {/* Sign out */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 18 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: FG, fontFamily: FONT }}>Sign out</div>
              <div style={{ fontSize: 12.5, fontWeight: 500, color: MUTED, marginTop: 2, fontFamily: FONT }}>End your session on this device.</div>
            </div>
            <button
              type="button"
              onClick={() => { void handleSignOut() }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px', borderRadius: 'var(--t-radius-input)', border: `1px solid ${BORDER}`, background: BG, cursor: 'pointer', fontFamily: FONT, fontSize: 13.5, fontWeight: 700, color: FG }}
            >
              <span>⏻</span> Sign out
            </button>
          </div>

          {/* Delete account — deferred (PRF-13) */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '16px 18px', borderRadius: 13, background: '#fdf0f2', border: '1px solid #fad9de' }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#d3415a', fontFamily: FONT }}>Delete account</div>
              <div style={{ fontSize: 12.5, fontWeight: 500, color: '#c47a86', marginTop: 2, fontFamily: FONT }}>Permanently remove your account and all recordings.</div>
            </div>
            <button
              type="button"
              disabled
              title="Coming soon"
              style={{ flexShrink: 0, padding: '10px 18px', borderRadius: 'var(--t-radius-input)', border: '1px solid #ef5a6f', background: '#fff', cursor: 'not-allowed', fontFamily: FONT, fontSize: 13.5, fontWeight: 700, color: '#ef5a6f', opacity: 0.5 }}
            >
              Delete
            </button>
          </div>
        </Card>

      </main>

      {/* Remove-avatar confirmation */}
      {confirmRemoveAvatar && (
        <div
          onClick={() => { if (!avatarSaving) setConfirmRemoveAvatar(false) }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(20,22,40,0.4)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}
        >
          <div
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 380, background: BG, border: `1px solid ${BORDER}`, borderRadius: 16, padding: 24, boxShadow: '0 24px 60px rgba(20,22,40,0.28)', fontFamily: FONT }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, color: FG, marginBottom: 8 }}>Remove profile photo?</div>
            <div style={{ fontSize: 13.5, fontWeight: 500, color: MUTED, lineHeight: 1.5, marginBottom: 20 }}>
              Your avatar will be removed and replaced with your initials. You can upload a new photo any time.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <SecondaryBtn onClick={() => setConfirmRemoveAvatar(false)} disabled={avatarSaving}>Cancel</SecondaryBtn>
              <button
                type="button"
                disabled={avatarSaving}
                onClick={() => { void handleAvatarRemove() }}
                style={{ padding: '10px 18px', borderRadius: 'var(--t-radius-input)', border: 'none', background: '#ef5a6f', cursor: avatarSaving ? 'default' : 'pointer', fontFamily: FONT, fontSize: 13.5, fontWeight: 700, color: '#fff', opacity: avatarSaving ? 0.65 : 1 }}
              >
                {avatarSaving ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
