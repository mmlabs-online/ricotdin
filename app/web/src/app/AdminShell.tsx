// Standalone admin layout from the Figma Make design. Each section is its own route; the
// screens themselves are wired in ARC-14.
import { ArrowUpRight, ShieldCheck } from 'lucide-react'
import { NavLink, Outlet, useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../auth/AuthProvider'
import { ADMIN_SECTIONS } from './adminSections'
import { initials } from './initials'

export function AdminShell() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { state } = useAuth()
  const user = state.status === 'signedIn' ? state.user : null
  return (
    <div className="admin-standalone">
      <header className="standalone-admin-header">
        <div className="admin-brand">
          <div className="admin-brand-mark" aria-hidden="true">
            <ShieldCheck size={18} />
          </div>
          <div>
            <strong>{t('app.name')}</strong>
            <span>{t('admin.brand')}</span>
          </div>
        </div>
        <div className="admin-header-actions">
          <button type="button" className="return-to-app" onClick={() => navigate('/meetings')}>
            {t('admin.returnToApp')} <ArrowUpRight size={14} aria-hidden="true" />
          </button>
          <div className="avatar" aria-hidden="true">
            {initials(user)}
          </div>
        </div>
      </header>
      <main className="standalone-admin-main">
        <div className="admin-area">
          <div className="admin-shell">
            <nav className="admin-nav" aria-label={t('admin.sections')}>
              {ADMIN_SECTIONS.map(({ slug, key, icon: Icon }) => (
                <NavLink key={key} to={slug ? `/admin/${slug}` : '/admin'} end className={({ isActive }) => (isActive ? 'active' : '')}>
                  <Icon size={16} aria-hidden="true" />
                  <span>{t(`admin.tabs.${key}`)}</span>
                </NavLink>
              ))}
            </nav>
            <div className="admin-panel">
              <Outlet />
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
