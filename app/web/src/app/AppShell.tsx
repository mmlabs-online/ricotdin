// Workspace layout from the Figma Make design: sidebar, top bar with the account menu, mobile nav.
// Quota and "Shared with me" / "Archive" widgets of the prototype are left out until their data
// exists (ARC-13).
import { useEffect, useId, useRef, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  CircleUserRound,
  Home,
  Languages,
  LogOut,
  MessageSquareText,
  Mic2,
  Moon,
  PanelLeftClose,
  Settings,
  Sun,
  type LucideIcon,
} from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { Logo } from '../components/Logo'
import { Button } from '../components/ui/Button'
import { ThemeSwatches } from '../components/ui/ThemeSwatches'
import { setLocale } from '../i18n'
import { useTheme } from '../theme/ThemeProvider'
import { initials } from './initials'

type NavEntry = { to: string; icon: LucideIcon; label: string; adminOnly?: boolean }

export function AppShell() {
  const { t, i18n } = useTranslation()
  const { state, session } = useAuth()
  const { dark, setDark, colorTheme, setColorTheme } = useTheme()
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const langLabelId = useId()
  const user = state.status === 'signedIn' ? state.user : null
  const isAdmin = user?.role === 'admin'
  const language = i18n.resolvedLanguage === 'vi' ? 'vi' : 'en'

  useEffect(() => {
    if (!menuOpen) return
    const outside = (target: EventTarget | null) => !menuRef.current?.contains(target as Node | null)
    const onMouse = (event: MouseEvent) => {
      if (outside(event.target)) setMenuOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setMenuOpen(false)
      triggerRef.current?.focus() // never leave focus on a removed element
    }
    const onFocus = (event: FocusEvent) => {
      if (outside(event.target)) setMenuOpen(false) // tabbed past the last item
    }
    document.addEventListener('mousedown', onMouse)
    document.addEventListener('keydown', onKey)
    document.addEventListener('focusin', onFocus)
    return () => {
      document.removeEventListener('mousedown', onMouse)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('focusin', onFocus)
    }
  }, [menuOpen])

  const nav: NavEntry[] = [
    { to: '/meetings', icon: Home, label: t('nav.meetings') },
    { to: '/record', icon: Mic2, label: t('nav.record') },
    { to: '/chat', icon: MessageSquareText, label: t('nav.chat') },
    { to: '/profile', icon: CircleUserRound, label: t('nav.profile') },
  ]
  const mobileNav: NavEntry[] = [
    ...nav.slice(0, 3),
    { to: '/admin', icon: Settings, label: t('nav.admin'), adminOnly: true },
    nav[3]!,
  ].filter((item) => !item.adminOnly || isAdmin)

  const signOut = async () => {
    setMenuOpen(false)
    const confirmed = await session.signOut()
    navigate('/sign-in', { replace: true, state: confirmed ? null : { signOutFailed: true } })
  }

  return (
    <div className="app">
      <aside className={collapsed ? 'sidebar collapsed' : 'sidebar'}>
        <div className="brand">
          <Logo />
          {!collapsed && <span>{t('app.name')}</span>}
          <Button
            variant="ghost"
            className="collapse-btn"
            aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}
          >
            <PanelLeftClose size={18} />
          </Button>
        </div>
        <nav className="nav" aria-label={t('nav.main')}>
          {nav.map(({ to, icon: Icon, label }) => (
            <NavLink key={to} to={to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`} aria-label={label} title={label}>
              <Icon aria-hidden="true" />
              {!collapsed && <span>{label}</span>}
            </NavLink>
          ))}
          {isAdmin && (
            <NavLink to="/admin" className="nav-item admin-compact" aria-label={t('nav.admin')} title={t('nav.admin')}>
              <Settings aria-hidden="true" />
            </NavLink>
          )}
        </nav>
        {isAdmin && !collapsed && (
          <div className="sidebar-section">
            <NavLink to="/admin" className={({ isActive }) => `side-link admin-link ${isActive ? 'active' : ''}`}>
              <Settings size={16} aria-hidden="true" /> {t('nav.admin')}
            </NavLink>
          </div>
        )}
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="mobile-brand">
            <Logo size={16} />
            <strong>{t('app.name')}</strong>
          </div>
          <span className="privacy">
            <span className="privacy-dot" /> {t('app.privacy')}
          </span>
          <div className="top-actions" ref={menuRef}>
            <Button variant="ghost" aria-label={t('menu.darkMode')} aria-pressed={dark} onClick={() => setDark(!dark)}>
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </Button>
            <button
              type="button"
              ref={triggerRef}
              className="user-trigger"
              onClick={() => setMenuOpen(!menuOpen)}
              aria-expanded={menuOpen}
              aria-controls={menuId}
              aria-label={t('menu.openFor', { name: user?.username || user?.email || '' })}
            >
              <div className="avatar" aria-hidden="true">
                {initials(user)}
              </div>
              <ChevronDown size={15} aria-hidden="true" />
            </button>
            {menuOpen && (
              <div className="user-menu" id={menuId}>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    navigate('/profile')
                  }}
                >
                  <CircleUserRound size={16} />
                  {t('nav.profile')}
                </button>
                <div className="menu-language">
                  <Languages size={16} />
                  <span id={langLabelId}>{t('menu.language')}</span>
                  <div role="group" aria-labelledby={langLabelId}>
                    <button type="button" className={language === 'en' ? 'active' : ''} aria-pressed={language === 'en'} aria-label={t('language.en')} lang="en" onClick={() => setLocale('en')}>
                      {t('language.enShort')}
                    </button>
                    <button type="button" className={language === 'vi' ? 'active' : ''} aria-pressed={language === 'vi'} aria-label={t('language.vi')} lang="vi" onClick={() => setLocale('vi')}>
                      {t('language.viShort')}
                    </button>
                  </div>
                </div>
                <div className="menu-theme">
                  <span>{t('menu.colorTheme')}</span>
                  <ThemeSwatches value={colorTheme} onChange={setColorTheme} />
                </div>
                <button type="button" onClick={() => setDark(!dark)}>
                  {dark ? <Sun size={16} /> : <Moon size={16} />}
                  {dark ? t('menu.lightMode') : t('menu.darkMode')}
                </button>
                <button type="button" onClick={() => void signOut()}>
                  <LogOut size={16} />
                  {t('menu.signOut')}
                </button>
              </div>
            )}
          </div>
        </header>
        <div className="content">
          <Outlet />
        </div>
      </main>

      <nav className="mobile-nav" aria-label={t('nav.mobile')}>
        {mobileNav.map(({ to, icon: Icon, label }) => (
          <NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'active' : '')}>
            <Icon size={20} aria-hidden="true" />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
