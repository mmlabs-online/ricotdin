import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import type { UploadStatus } from '../lib/upload/useMeetingUpload'
import { Button } from './ui/Button'

/** Progress / success / error of a meeting upload (shared by record and file upload). */
export function UploadStatusView({ status, onRetry }: { status: UploadStatus; onRetry?: () => void }) {
  const { t } = useTranslation()
  if (status.phase === 'uploading') {
    const pct = Math.round(status.progress * 100)
    return (
      <div className="upload-status" role="status">
        <label>
          {t('upload.uploading', { pct })}
          <progress max={100} value={pct} />
        </label>
      </div>
    )
  }
  if (status.phase === 'done') {
    return (
      <div className="upload-status success" role="status">
        <p>{t('upload.done')}</p>
        <Link className="button button-primary" to={`/meetings/${encodeURIComponent(status.meetingId)}`}>
          {t('upload.openMeeting')}
        </Link>
      </div>
    )
  }
  if (status.phase === 'error') {
    return (
      <div className="upload-status error" role="alert">
        <p>{t(status.errorKey)}</p>
        {onRetry && <Button onClick={onRetry}>{t('common.tryAgain')}</Button>}
      </div>
    )
  }
  return null
}
