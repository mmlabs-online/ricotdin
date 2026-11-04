import { useEffect, useRef } from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import type { UploadStatus } from '../lib/upload/useMeetingUpload'
import { Button } from './ui/Button'

/** Progress / success / error of a meeting upload (shared by record and file upload).
 * One polite region always exists and only announces the phase (never each percent); focus moves
 * to the next useful control when the phase changes, since the button that started it is gone. */
export function UploadStatusView({ status, onRetry }: { status: UploadStatus; onRetry?: () => void }) {
  const { t } = useTranslation()
  const progressRef = useRef<HTMLProgressElement>(null)
  const linkRef = useRef<HTMLAnchorElement>(null)
  const retryRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (status.phase === 'uploading') progressRef.current?.focus()
    else if (status.phase === 'done') linkRef.current?.focus()
    else if (status.phase === 'error') retryRef.current?.focus()
  }, [status.phase])

  const announce =
    status.phase === 'uploading' ? t('upload.started') : status.phase === 'done' ? t('upload.done') : ''
  const pct = status.phase === 'uploading' ? Math.round(status.progress * 100) : 0
  return (
    <>
      <p className="sr-only" role="status">
        {announce}
      </p>
      {status.phase === 'uploading' && (
        <div className="upload-status">
          <span aria-hidden="true">{t('upload.uploading', { pct })}</span>
          <progress ref={progressRef} tabIndex={-1} max={100} value={pct} aria-label={t('upload.progressLabel')} />
        </div>
      )}
      {status.phase === 'done' && (
        <div className="upload-status success">
          <p aria-hidden="true">{t('upload.done')}</p>
          <Link ref={linkRef} className="button button-primary" to={`/meetings/${encodeURIComponent(status.meetingId)}`}>
            {t('upload.openMeeting')}
          </Link>
        </div>
      )}
      {status.phase === 'error' && (
        <div className="upload-status error">
          <p role="alert">{t(status.errorKey)}</p>
          {onRetry && (
            <Button ref={retryRef} onClick={onRetry}>
              {t('common.tryAgain')}
            </Button>
          )}
        </div>
      )}
    </>
  )
}
