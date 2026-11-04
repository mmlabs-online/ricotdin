import { useTranslation } from 'react-i18next'
import { Button } from './ui/Button'

export function ErrorScreen({ messageKey = 'error.body' }: { messageKey?: 'error.body' | 'error.config' }) {
  const { t } = useTranslation()
  return (
    <div className="full-page-state" role="alert">
      <h1>{t('error.title')}</h1>
      <p>{t(messageKey)}</p>
      <Button variant="primary" onClick={() => window.location.reload()}>
        {t('error.reload')}
      </Button>
    </div>
  )
}
