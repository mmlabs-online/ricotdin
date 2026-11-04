import { useTranslation } from 'react-i18next'
import { useDocumentTitle } from '../lib/useDocumentTitle'

export function AdminSectionPage({ sectionKey }: { sectionKey: string }) {
  const { t } = useTranslation()
  useDocumentTitle(`admin.tabs.${sectionKey}`)
  return (
    <>
      <div className="page-head admin-heading">
        <div>
          <span className="eyebrow">{t('admin.eyebrow')}</span>
          <h1>{t(`admin.tabs.${sectionKey}`)}</h1>
          <p>{t('admin.subtitle')}</p>
        </div>
      </div>
      <div className="empty">
        <p>{t('page.comingSoon')}</p>
      </div>
    </>
  )
}
