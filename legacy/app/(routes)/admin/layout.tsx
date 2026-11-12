'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { getCurrentRole } from '@/lib/supabase/auth'
import {
  Users,
  Activity,
  BarChart2,
  FileText,
  Heart,
  Settings,
  ArrowLeft,
  Lock,
  Key,
  BookOpen,
  History,
  Layers,
  HardDrive,
} from 'lucide-react'

// ── Nav item definition ───────────────────────────────────────────────────────

type NavItem = {
  label: string
  href: string
  icon: React.ReactNode
  soon?: boolean
}

const NAV: NavItem[] = [
  { label: 'Users',     href: '/admin/users',      icon: <Users     size={16} /> },
  { label: 'Pipeline',  href: '/admin/pipeline',  icon: <Activity  size={16} /> },
  { label: 'Activity',  href: '/admin/activity',  icon: <History   size={16} /> },
  { label: 'Usage',     href: '/admin/usage',     icon: <BarChart2 size={16} /> },
  { label: 'Keys',      href: '/admin/keys',      icon: <Key       size={16} /> },
  { label: 'Storage',   href: '/admin/storage',   icon: <HardDrive size={16} /> },
  { label: 'Audit Log', href: '/admin/audit',     icon: <FileText  size={16} /> },
  { label: 'Health',    href: '/admin/health',    icon: <Heart     size={16} /> },
  { label: 'Config',    href: '/admin/config',    icon: <Settings  size={16} /> },
  { label: 'Features',  href: '/admin/features',  icon: <Layers    size={16} /> },
  { label: 'API Docs',  href: '/admin/docs',      icon: <BookOpen  size={16} /> },
]

// ── Sidebar ───────────────────────────────────────────────────────────────────

function Sidebar() {
  const pathname = usePathname()

  function isActive(href: string) {
    return pathname.startsWith(href)
  }

  return (
    <aside style={S.sidebar} >
      {/* Brand */}
      <div style={{display: 'block', padding: "10px 20px"} }>
        <img src="/short-logo-w.png" alt="Ricotdin" style={{ height: '50px', width: '50px', display: 'inline-block' }} />
        <span style={S.brandSub}>Admin Panel</span>
      </div>

      <div style={S.divider} />

      {/* Navigation */}
      <nav style={S.nav}>
        <p style={S.navSection}>Navigation</p>
        {NAV.map((item) => {
          const active = !item.soon && isActive(item.href)
          return item.soon ? (
            <div key={item.href} style={S.navItemDisabled} title="Coming soon">
              <span style={S.navIcon}>{item.icon}</span>
              <span style={S.navLabel}>{item.label}</span>
              <span style={S.soonBadge}>Soon</span>
            </div>
          ) : (
            <Link
              key={item.href}
              href={item.href}
              style={active ? { ...S.navItem, ...S.navItemActive } : S.navItem}
            >
              {active && <span style={S.activeBar} />}
              <span style={S.navIcon}>{item.icon}</span>
              <span style={S.navLabel}>{item.label}</span>
            </Link>
          )
        })}
      </nav>

      {/* Footer */}
      <div style={S.footer}>
        <div style={S.divider} />
        <Link href="/meetings" style={S.backLink}>
          <ArrowLeft size={14} />
          Back to app
        </Link>
      </div>
    </aside>
  )
}

// ── Layout ────────────────────────────────────────────────────────────────────

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [authState, setAuthState] = useState<'loading' | 'allowed' | 'forbidden' | 'unauthenticated'>('loading')

  useEffect(() => {
    getCurrentRole().then((role) => {
      if (role === null) {
        setAuthState('unauthenticated')
      } else if (role === 'admin') {
        setAuthState('allowed')
      } else {
        setAuthState('forbidden')
      }
    })
  }, [])

  if (authState === 'loading') {
    return (
      <div style={S.guardCenter}>
        <p style={S.guardMuted}>Loading…</p>
      </div>
    )
  }

  if (authState === 'unauthenticated') {
    router.replace('/login')
    return null
  }

  if (authState === 'forbidden') {
    return (
      <div style={S.guardCenter}>
        <div style={S.guardCard}>
          <div style={S.guardIconWrap}>
            <Lock size={28} color="#ef4444" />
          </div>
          <h1 style={S.guardTitle}>Access Denied</h1>
          <p style={S.guardBody}>
            You don&apos;t have permission to access the Admin Panel.
            This area is restricted to administrators only.
          </p>
          <Link href="/meetings" style={S.guardBtn}>
            ← Back to app
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div style={S.shell}>
      <Sidebar />
      <main style={S.content}>
        {children}
      </main>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  // Layout shell
  shell: {
    display: 'flex',
    height: '100vh',
    overflow: 'hidden',
    fontFamily: 'var(--t-font-body)',
    background: 'rgb(var(--t-bg-rgb))',
  },
  content: {
    flex: 1,
    overflowY: 'auto',
    minWidth: 0,
  },

  // Sidebar
  sidebar: {
    width: 240,
    minWidth: 240,
    background: '#0f172a',
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    overflowY: 'auto',
  },

  // Brand area
  brand: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
    padding: '20px 18px 18px',
  },
  brandSub: {
    fontSize: 14,
    color: '#64748b',
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    marginTop: 2,
    marginLeft: 10,
  },

  // Divider
  divider: {
    height: 1,
    background: '#1e293b',
    margin: '0 16px',
  },

  // Nav
  nav: {
    flex: 1,
    padding: '16px 0',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  navSection: {
    fontSize: 10,
    fontWeight: 600,
    color: '#475569',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    margin: '0 0 6px',
    padding: '0 18px',
  },
  navItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '9px 18px',
    borderRadius: 0,
    textDecoration: 'none',
    color: '#94a3b8',
    fontSize: 13,
    fontWeight: 500,
    position: 'relative',
    transition: 'background 0.12s, color 0.12s',
    cursor: 'pointer',
  },
  navItemActive: {
    background: '#1e293b',
    color: '#e2e8f0',
  },
  navItemDisabled: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '9px 18px',
    color: '#334155',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'not-allowed',
    userSelect: 'none',
  },
  activeBar: {
    position: 'absolute',
    left: 0,
    top: 4,
    bottom: 4,
    width: 3,
    background: '#3b82f6',
    borderRadius: '0 2px 2px 0',
  },
  navIcon: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    opacity: 0.8,
  },
  navLabel: {
    flex: 1,
  },
  soonBadge: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    background: '#1e293b',
    color: '#475569',
    padding: '2px 6px',
    borderRadius: 99,
    border: '1px solid #273549',
  },

  // Footer
  footer: {
    padding: '0 0 8px',
  },
  backLink: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '12px 18px',
    color: '#475569',
    textDecoration: 'none',
    fontSize: 12,
    fontWeight: 500,
  },

  // Auth guard states
  guardCenter: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgb(var(--t-bg-rgb))',
    fontFamily: 'var(--t-font-body)',
  },
  guardMuted: {
    color: 'rgb(var(--t-fg-rgb) / 0.5)',
    fontSize: 14,
  },
  guardCard: {
    background: 'white',
    borderRadius: 'var(--t-radius-card)',
    padding: '40px 48px',
    maxWidth: 400,
    width: '90%',
    textAlign: 'center' as const,
    boxShadow: 'var(--t-shadow-md)',
    border: '1px solid rgb(var(--t-border-rgb))',
  },
  guardIconWrap: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 56,
    height: 56,
    background: '#fee2e2',
    borderRadius: '50%',
    margin: '0 auto 20px',
  },
  guardTitle: {
    margin: '0 0 12px',
    fontSize: 20,
    fontWeight: 700,
    color: 'rgb(var(--t-fg-rgb))',
    fontFamily: 'var(--t-font-heading)',
  },
  guardBody: {
    margin: '0 0 28px',
    fontSize: 14,
    color: 'rgb(var(--t-fg-rgb) / 0.6)',
    lineHeight: 1.6,
  },
  guardBtn: {
    display: 'inline-block',
    padding: '9px 20px',
    background: 'rgb(var(--t-fg-rgb))',
    color: 'rgb(var(--t-bg-rgb))',
    borderRadius: 'var(--t-radius-btn)',
    textDecoration: 'none',
    fontSize: 13,
    fontWeight: 600,
  },
}
