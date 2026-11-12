import { useTranslation } from 'react-i18next'
import { Button } from './ui/Button'

export function ErrorScreen({
  messageKey = 'error.body',
  onRetry,
}: {
  messageKey?: 'error.body' | 'error.config' | 'error.unavailable'
  onRetry?: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="full-page-state" role="alert">
      <h1>{t('error.title')}</h1>
      <p>{t(messageKey)}</p>
      <Button variant="primary" onClick={onRetry ?? (() => window.location.reload())}>
        {onRetry ? t('error.retry') : t('error.reload')}
      </Button>
    </div>
  )
}
