import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useDocumentTitle } from '../lib/useDocumentTitle'

export function StatusPage({ kind }: { kind: 'notFound' | 'forbidden' }) {
  const { t } = useTranslation()
  useDocumentTitle(`page.${kind}.title`)
  return (
    <main className="full-page-state">
      <h1>{t(`page.${kind}.title`)}</h1>
      <p>{t(`page.${kind}.subtitle`)}</p>
      <Link className="button button-primary" to="/meetings">
        {t(`page.${kind}.home`)}
      </Link>
    </main>
  )
}
