// Record a meeting (REC-01..04 + COM-01), Figma Make "Record this meeting" card.
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Mic2, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuth, useFetchApi } from '../auth/AuthProvider'
import { useRecorder } from '../lib/audio/useRecorder'
import { isNoticeAcknowledged, storeNoticeAcknowledged } from '../lib/consent/recordingNotice'
import { formatClock } from '../lib/media/seek'
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, formatBytes, recordingExtension } from '../lib/upload/rules'
import { useMeetingUpload } from '../lib/upload/useMeetingUpload'
import { RecordingNoticeDialog } from './RecordingNoticeDialog'
import { UploadStatusView } from './UploadStatusView'
import { Button } from './ui/Button'

export function Recorder({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const { t } = useTranslation()
  const fetchApi = useFetchApi()
  const { state: auth } = useAuth()
  const rec = useRecorder()
  const { status, upload, reset: resetUpload } = useMeetingUpload()
  const [showNotice, setShowNotice] = useState(false)
  const startedAt = useRef<string | null>(null)
  const busy = rec.state === 'recording' || rec.state === 'starting' || status.phase === 'uploading'

  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange])

  if (rec.missing.length > 0) {
    return (
      <section className="record-card" role="alert">
        <h2>{t('record.unsupported.title')}</h2>
        <p>{t('record.unsupported.body')}</p>
        <ul className="missing-list">
          {rec.missing.map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ul>
      </section>
    )
  }

  const begin = () => {
    startedAt.current = new Date().toISOString()
    void rec.start()
  }
  const onStartClick = () => (isNoticeAcknowledged() ? begin() : setShowNotice(true))
  const onNoticeConfirm = () => {
    setShowNotice(false)
    storeNoticeAcknowledged()
    begin() // synchronously inside the click: the capture prompts need the user activation
    if (auth.status === 'signedIn') {
      // Best-effort compliance trail (COM-01); a failure never blocks recording.
      void fetchApi('/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType: 'recording_notice_ack', userId: auth.user.id }),
      }).catch(() => undefined)
    }
  }

  const tooBig = rec.blob !== null && rec.blob.size > MAX_UPLOAD_BYTES
  const onUpload = () => {
    if (!rec.blob || tooBig) return
    const mimeType = rec.mimeType || rec.blob.type || 'audio/webm'
    void upload(rec.blob, {
      ext: recordingExtension(mimeType),
      mimeType,
      source: 'recorded',
      durationSeconds: rec.elapsedSeconds,
      startedAt: startedAt.current ?? new Date().toISOString(),
    })
  }
  const discard = () => {
    resetUpload()
    rec.reset()
  }

  return (
    <section className="record-card" aria-labelledby="record-title">
      <div className={`record-orb${rec.state === 'recording' ? ' live' : ''}`} aria-hidden="true">
        <Mic2 size={35} />
      </div>
      <h2 id="record-title">{t('record.card.title')}</h2>

      {(rec.state === 'idle' || rec.state === 'starting') && (
        <>
          <p>{t('record.card.body')}</p>
          <Button variant="primary" className="start-btn" onClick={onStartClick} disabled={rec.state === 'starting'}>
            <span className="record-dot" aria-hidden="true" />{' '}
            {rec.state === 'starting' ? t('record.waiting') : t('record.start')}
          </Button>
          <div className="capture-list">
            <span>
              <Check size={16} aria-hidden="true" /> {t('record.capture.mic')}
            </span>
            <span>
              <Check size={16} aria-hidden="true" /> {t('record.capture.tab')}
            </span>
            <span>
              <Check size={16} aria-hidden="true" /> {t('record.capture.secure')}
            </span>
          </div>
        </>
      )}

      {rec.state === 'recording' && (
        <>
          <p className="record-timer" role="timer" aria-label={t('record.elapsed')}>
            {formatClock(rec.elapsedSeconds)}
          </p>
          {rec.trackInfo && !rec.trackInfo.hasDisplayAudio && (
            <div className="notice-banner warning" role="alert">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>{t('record.noTabAudio')}</span>
            </div>
          )}
          <Button variant="danger" className="start-btn" onClick={rec.stop}>
            <Square size={14} aria-hidden="true" /> {t('record.stop')}
          </Button>
        </>
      )}

      {rec.state === 'stopped' && rec.blob && (
        <>
          <p>
            {t('record.stopped', { time: formatClock(rec.elapsedSeconds), size: formatBytes(rec.blob.size) })}
          </p>
          {rec.objectUrl && <audio className="record-preview" src={rec.objectUrl} controls aria-label={t('record.preview')} />}
          {rec.trackInfo && !rec.trackInfo.hasDisplayAudio && (
            <div className="notice-banner warning">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>{t('record.noTabAudioAfter')}</span>
            </div>
          )}
          {tooBig && (
            <p className="notice-banner error" role="alert">
              {t('upload.errors.size', { max: MAX_UPLOAD_LABEL })}
            </p>
          )}
          {(status.phase === 'idle' || status.phase === 'error') && (
            <div className="record-actions">
              <Button variant="ghost" onClick={discard}>
                {t('record.discard')}
              </Button>
              <Button variant="primary" onClick={onUpload} disabled={tooBig}>
                {t('record.upload')}
              </Button>
            </div>
          )}
          <UploadStatusView status={status} onRetry={onUpload} />
          {status.phase === 'done' && (
            <Button variant="ghost" onClick={discard}>
              {t('record.another')}
            </Button>
          )}
        </>
      )}

      {rec.state === 'error' && (
        <div role="alert">
          <p>{t(rec.errorKey ?? 'record.errors.generic')}</p>
          <Button onClick={rec.reset}>{t('common.tryAgain')}</Button>
        </div>
      )}

      {showNotice && <RecordingNoticeDialog onConfirm={onNoticeConfirm} onCancel={() => setShowNotice(false)} />}
    </section>
  )
}
