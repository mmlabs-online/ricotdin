import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Logo } from '../components/Logo'

/** Targets of the API's email links (`#token=` in the fragment). Public: a signed-out visitor must
 * not be bounced through /sign-in, which would copy the fragment into a URL. ARC-13 builds the
 * forms; until then the token is left untouched in the fragment. */
export function PublicPlaceholderPage({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation()
  return (
    <div className="auth-page">
      <div className="auth-top">
        <div className="brand">
          <Logo />
          <span>{t('app.name')}</span>
        </div>
      </div>
      <main className="auth-card">
        <h1>{t(titleKey)}</h1>
        <p>{t('auth.comingSoon')}</p>
        <Link className="button button-primary full" to="/sign-in">
          {t('auth.submit')}
        </Link>
      </main>
    </div>
  )
}
