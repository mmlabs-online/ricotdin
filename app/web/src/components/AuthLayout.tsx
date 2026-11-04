import type { ReactNode } from 'react'
import { Languages } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { setLocale } from '../i18n'
import { Logo } from './Logo'

/** Signed-out pages (Figma Make AuthView): brand + language switch, then the card. */
export function AuthLayout({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation()
  const language = i18n.resolvedLanguage === 'vi' ? 'vi' : 'en'
  return (
    <div className="auth-page">
      <header className="auth-top">
        <div className="brand">
          <Logo />
          <span>{t('app.name')}</span>
        </div>
        <div className="language-switch" role="group" aria-label={t('language.label')}>
          <Languages size={15} aria-hidden="true" />
          <button type="button" className={language === 'en' ? 'active' : ''} aria-pressed={language === 'en'} lang="en" onClick={() => setLocale('en')}>
            {t('language.en')}
          </button>
          <button type="button" className={language === 'vi' ? 'active' : ''} aria-pressed={language === 'vi'} lang="vi" onClick={() => setLocale('vi')}>
            {t('language.vi')}
          </button>
        </div>
      </header>
      <main>{children}</main>
    </div>
  )
}
