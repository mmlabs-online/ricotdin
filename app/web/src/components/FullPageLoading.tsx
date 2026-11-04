import { LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function FullPageLoading() {
  const { t } = useTranslation()
  return (
    <div className="full-page-state" role="status" aria-live="polite">
      <LoaderCircle className="spin" size={22} aria-hidden="true" />
      <span>{t('app.loading')}</span>
    </div>
  )
}
