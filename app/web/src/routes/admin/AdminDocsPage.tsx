// Admin › API docs (ARC-14c): the API serves /docs and /openapi.json only when API_DOCS=1 (§0.2).
// This page checks whether they are on and links to them; it never embeds them.
import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AdminHead } from '../../components/admin/AdminParts'
import { Status } from '../../components/ui/Status'
import { useApiUrl } from '../../auth/AuthProvider'
import { useDocumentTitle } from '../../lib/useDocumentTitle'

export function AdminDocsPage() {
  const { t } = useTranslation()
  useDocumentTitle('admin.tabs.docs')
  const api = useApiUrl()
  const docs = useQuery({
    queryKey: ['admin', 'docs', api],
    retry: false,
    queryFn: async () => {
      const res = await fetch(`${api}/openapi.json`, { method: 'GET', credentials: 'omit', cache: 'no-store' })
      return res.ok
    },
  })
  return (
    <>
      <AdminHead titleKey="admin.tabs.docs" subtitleKey="admin.docs.subtitle" />
      <section className="admin-card" aria-labelledby="docs-head">
        <div className="card-head">
          <h2 id="docs-head">{t('admin.docs.title')}</h2>
          {docs.data !== undefined && <Status type={docs.data ? 'success' : 'processing'}>{t(docs.data ? 'admin.docs.on' : 'admin.docs.off')}</Status>}
        </div>
        {docs.isPending ? (
          <p className="tab-note">{t('common.loading')}</p>
        ) : docs.data ? (
          <ul className="docs-links">
            <li>
              <a className="card-link" href={`${api}/docs`} target="_blank" rel="noopener noreferrer">
                {t('admin.docs.swagger')} <ArrowUpRight size={13} aria-hidden="true" />
                <span className="sr-only">{t('admin.docs.newTab')}</span>
              </a>
            </li>
            <li>
              <a className="card-link" href={`${api}/redoc`} target="_blank" rel="noopener noreferrer">
                {t('admin.docs.redoc')} <ArrowUpRight size={13} aria-hidden="true" />
                <span className="sr-only">{t('admin.docs.newTab')}</span>
              </a>
            </li>
            <li>
              <a className="card-link" href={`${api}/openapi.json`} target="_blank" rel="noopener noreferrer">
                {t('admin.docs.openapi')} <ArrowUpRight size={13} aria-hidden="true" />
                <span className="sr-only">{t('admin.docs.newTab')}</span>
              </a>
            </li>
          </ul>
        ) : (
          <p className="tab-note">{t('admin.docs.offHelp')}</p>
        )}
      </section>
    </>
  )
}
