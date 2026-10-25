'use client'

// Auth guard for all app routes. Redirects to /login if no session.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import { browserClient } from '@/lib/supabase/browser'
import { signOut } from '@/lib/supabase/auth'
import ThemeSwitcher from '@/components/ThemeSwitcher'
import { useTheme } from '@/hooks/useTheme'
import type { Theme } from '@/lib/theme'

export default function RoutesLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [email, setEmail] = useState<string | null>(null)
  const [username, setUsername] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const { setTheme } = useTheme()

  useEffect(() => {
    void browserClient.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) {
        router.replace('/login')
      } else {
        setEmail(session.user?.email ?? null)

        // Sync profile data (theme, display name, avatar) on session open.
        // Non-blocking: ignore errors — localStorage value is always the fallback.
        try {
          const res = await fetch('/api/profile', {
            headers: { Authorization: `Bearer ${session.access_token}` },
          })
          if (res.ok) {
            const data = await res.json() as {
              theme_preference?: Theme | null
              username?: string
              display_name?: string | null
              avatar_url?: string | null
            }
            if (data.theme_preference) setTheme(data.theme_preference)
            if (data.username) setUsername(data.username)
            if (data.display_name) setDisplayName(data.display_name)
            if (data.avatar_url) setAvatarUrl(data.avatar_url)
          }
        } catch { /* non-fatal */ }
      }
    })

    const { data: { subscription } } = browserClient.auth.onAuthStateChange(
      (event) => {
        if (event === 'SIGNED_OUT') router.replace('/login')
      },
    )
    return () => subscription.unsubscribe()
  }, [router])

  // Close dropdown on outside click
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [])

  // No full-screen "Loading…" gate: render the shell immediately so pages can
  // show their own skeletons while the session check runs. The useEffect above
  // still redirects to /login when there is no session.

  // Admin pages have their own full-screen layout (dark sidebar shell).
  // Return children directly so the admin layout renders without the top nav.
  if (pathname.startsWith('/admin')) return <>{children}</>

  async function handleSignOut() {
    await signOut()
    router.replace('/login')
  }

  const navLinks = [
    { href: '/meetings', label: 'Meetings' },
    { href: '/record',   label: 'Record'   },
    { href: '/chat',     label: 'Chat'     },
  ]

  return (
    <>
      {/* Top nav bar */}
      <header className="sticky top-0 z-40 bg-b-bg/90 backdrop-blur-sm border-b border-b-border">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 flex items-center justify-between h-14">
          {/* Logo */}
          <Link href="/meetings" aria-label="Ricotdin home">
            <img src="/short-logo.png" alt="Ricotdin" style={{ height: '30px', width: 'auto' }} />
          </Link>

          {/* Nav links */}
          <nav className="hidden sm:flex items-center gap-1">
            {navLinks.map(({ href, label }) => {
              const active = pathname === href || pathname.startsWith(href + '/')
              return (
                <Link
                  key={href}
                  href={href}
                  className={[
                    'px-3 py-1.5 rounded-full text-sm font-sans font-medium tracking-wide transition-all duration-300',
                    active
                      ? 'bg-b-fg text-white'
                      : 'text-b-fg/60 hover:text-b-fg hover:bg-b-clay',
                  ].join(' ')}
                >
                  {label}
                </Link>
              )
            })}
          </nav>

          {/* Theme switcher + profile dropdown */}
          <div className="flex items-center gap-2">
            <ThemeSwitcher />
            {/* Profile avatar button + dropdown */}
            <div ref={dropdownRef} className="relative">
              <button
                onClick={() => setDropdownOpen((v) => !v)}
                className="flex items-center gap-2 px-2 py-1.5 rounded-full border border-b-border bg-b-bg hover:border-b-fg/20 transition-all duration-200 cursor-pointer"
                title="Account settings"
              >
                {/* Avatar circle */}
                <span
                  className="flex items-center justify-center w-7 h-7 rounded-full text-white text-xs font-bold font-sans shrink-0 overflow-hidden"
                  style={{ background: avatarUrl ? 'transparent' : 'linear-gradient(135deg, rgb(var(--t-secondary-rgb, var(--t-primary-rgb))), rgb(var(--t-primary-rgb)))' }}
                >
                  {avatarUrl
                    ? <img src={avatarUrl} alt="avatar" className="w-full h-full object-cover" />
                    : (displayName ?? username ?? email ?? '?').slice(0, 2).toUpperCase()
                  }
                </span>
                <span className="hidden md:block text-xs font-sans font-semibold text-b-fg/70 truncate max-w-[110px]">
                  {username ?? email}
                </span>
                <span className="text-b-fg/30 text-[10px]">▾</span>
              </button>

              {dropdownOpen && (
                <div
                  className="absolute right-0 top-full mt-2 w-52 rounded-2xl border border-b-border bg-b-bg shadow-lg py-1.5 z-50"
                  style={{ boxShadow: '0 8px 32px rgba(0,0,0,0.12)' }}
                >
                  {/* User info */}
                  <div className="px-4 py-2.5 border-b border-b-border">
                    <p className="text-xs font-bold text-b-fg font-sans truncate">{displayName ?? username}</p>
                    <p className="text-[11px] text-b-fg/40 font-sans truncate mt-0.5">{email}</p>
                  </div>
                  <Link
                    href="/profile"
                    className="flex items-center gap-2.5 px-4 py-2.5 text-sm font-sans font-semibold text-b-fg/70 hover:text-b-fg hover:bg-b-clay transition-colors duration-150 no-underline"
                    onClick={() => setDropdownOpen(false)}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                    Account settings
                  </Link>
                  <button
                    onClick={() => { setDropdownOpen(false); void handleSignOut() }}
                    className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm font-sans font-semibold text-b-fg/70 hover:text-b-fg hover:bg-b-clay transition-colors duration-150 cursor-pointer bg-transparent border-none text-left"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                      <polyline points="16 17 21 12 16 7" />
                      <line x1="21" y1="12" x2="9" y2="12" />
                    </svg>
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Mobile nav */}
        <div className="sm:hidden flex items-center gap-1 px-4 pb-2">
          {navLinks.map(({ href, label }) => {
            const active = pathname === href || pathname.startsWith(href + '/')
            return (
              <Link
                key={href}
                href={href}
                className={[
                  'px-3 py-1 rounded-full text-xs font-sans font-medium tracking-wide transition-all duration-300',
                  active
                    ? 'bg-b-fg text-white'
                    : 'text-b-fg/60 hover:text-b-fg hover:bg-b-clay',
                ].join(' ')}
              >
                {label}
              </Link>
            )
          })}
        </div>
      </header>

      <main className="flex-1">
        {children}
      </main>
    </>
  )
}
