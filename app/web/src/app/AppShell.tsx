// Workspace layout from the Figma Make design: sidebar, top bar with the account menu, mobile nav.
// Quota and "Shared with me" / "Archive" widgets of the prototype are left out until their data
// exists (ARC-13).
import { useEffect, useRef, useState } from 'react'
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
  const user = state.status === 'signedIn' ? state.user : null
  const isAdmin = user?.role === 'admin'
  const language = i18n.resolvedLanguage === 'vi' ? 'vi' : 'en'

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
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
    await session.signOut()
    navigate('/sign-in', { replace: true })
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
            <NavLink key={to} to={to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`} title={collapsed ? label : undefined}>
              <Icon aria-hidden="true" />
              {!collapsed && <span>{label}</span>}
            </NavLink>
          ))}
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
            <Button variant="ghost" aria-label={t('menu.toggleTheme')} onClick={() => setDark(!dark)}>
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </Button>
            <button
              type="button"
              className="user-trigger"
              onClick={() => setMenuOpen(!menuOpen)}
              aria-expanded={menuOpen}
              aria-haspopup="true"
              aria-label={t('menu.open')}
            >
              <div className="avatar" aria-hidden="true">
                {initials(user)}
              </div>
              <ChevronDown size={15} aria-hidden="true" />
            </button>
            {menuOpen && (
              <div className="user-menu">
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
                  <span>{t('menu.language')}</span>
                  <div>
                    <button type="button" className={language === 'en' ? 'active' : ''} aria-pressed={language === 'en'} onClick={() => setLocale('en')}>
                      {t('language.enShort')}
                    </button>
                    <button type="button" className={language === 'vi' ? 'active' : ''} aria-pressed={language === 'vi'} onClick={() => setLocale('vi')}>
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
