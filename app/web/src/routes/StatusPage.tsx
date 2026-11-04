import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'

export function StatusPage({ kind }: { kind: 'notFound' | 'forbidden' }) {
  const { t } = useTranslation()
  return (
    <div className="full-page-state">
      <h1>{t(`page.${kind}.title`)}</h1>
      <p>{t(`page.${kind}.subtitle`)}</p>
      <Link className="button button-primary" to="/meetings">
        {t(`page.${kind}.home`)}
      </Link>
    </div>
  )
}
