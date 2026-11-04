// Upload an existing audio/video file (REC-05), Figma Make dropzone + meeting date row.
import { useEffect, useId, useRef, useState, type DragEvent } from 'react'
import { CloudUpload, FileAudio, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ACCEPT, MAX_UPLOAD_LABEL, checkUploadFile, formatBytes, type FileCheck } from '../lib/upload/rules'
import { useMeetingUpload } from '../lib/upload/useMeetingUpload'
import { UploadStatusView } from './UploadStatusView'
import { Button } from './ui/Button'

/** Local now for a datetime-local input, trimmed to minutes. */
function localNow(): string {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

/** Media duration from the file's metadata (0 when the browser cannot tell). */
function readDuration(file: File, video: boolean): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const media = document.createElement(video ? 'video' : 'audio')
    let settled = false
    const done = (seconds: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      URL.revokeObjectURL(url)
      resolve(seconds)
    }
    const timer = setTimeout(() => done(0), 10_000) // a file that never loads must not pin the URL
    media.preload = 'metadata'
    media.onloadedmetadata = () => done(Number.isFinite(media.duration) ? Math.round(media.duration) : 0)
    media.onerror = () => done(0)
    media.src = url
  })
}

export function FileUploadPanel({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const dateId = useId()
  const dateHelpId = useId()
  const formatsId = useId()
  const chooseRef = useRef<HTMLButtonElement>(null)
  const [attempt, setAttempt] = useState(0) // re-announces a repeated identical error
  const [file, setFile] = useState<File | null>(null)
  const [check, setCheck] = useState<FileCheck | null>(null)
  const [duration, setDuration] = useState(0)
  const [date, setDate] = useState(localNow)
  const [dragging, setDragging] = useState(false)
  const { status, upload, retryConfirm, reset } = useMeetingUpload()
  const pickId = useRef(0) // only the latest file's duration counts

  useEffect(() => onBusyChange?.(status.phase === 'uploading'), [status.phase, onBusyChange])

  const pick = (picked: File | null) => {
    reset()
    setDuration(0)
    const id = ++pickId.current
    if (!picked) {
      setFile(null)
      setCheck(null)
      return
    }
    const result = checkUploadFile(picked.name, picked.size, picked.type)
    setAttempt((n) => n + 1)
    setCheck(result)
    setFile(result.ok ? picked : null)
    if (result.ok) {
      void readDuration(picked, result.source === 'video').then((seconds) => {
        if (id === pickId.current) setDuration(seconds)
      })
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (status.phase !== 'uploading') pick(e.dataTransfer.files[0] ?? null)
  }

  const start = () => {
    if (!file || !check?.ok) return
    const when = new Date(date)
    void upload(file, {
      ext: check.ext,
      mimeType: check.mimeType,
      source: check.source,
      durationSeconds: duration || null,
      startedAt: (Number.isNaN(when.getTime()) ? new Date() : when).toISOString(),
    })
  }

  const uploading = status.phase === 'uploading'
  return (
    <>
      <h2 className="sr-only">{t('upload.title')}</h2>
      <section
        className={`dropzone${dragging ? ' dragging' : ''}`}
        aria-label={t('upload.title')}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <CloudUpload size={27} aria-hidden="true" />
        <strong>{t('upload.drop')}</strong>
        <p id={formatsId}>{t('upload.formats', { max: MAX_UPLOAD_LABEL })}</p>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            pick(e.target.files?.[0] ?? null)
            e.target.value = '' // picking the same file again still fires change
          }}
        />
        <Button ref={chooseRef} onClick={() => inputRef.current?.click()} disabled={uploading} aria-describedby={formatsId}>
          {t('upload.choose')}
        </Button>
      </section>

      <p className="sr-only" role="status">
        {file ? t('upload.selected', { name: file.name, size: formatBytes(file.size) }) : ''}
      </p>
      {check && !check.ok && (
        <p key={attempt} className="notice-banner error" role="alert">
          {check.error === 'size'
            ? t('upload.errors.size', { max: MAX_UPLOAD_LABEL })
            : check.error === 'empty'
              ? t('upload.errors.empty')
              : t('upload.errors.type', { ext: check.ext || '—' })}
        </p>
      )}

      {file && (
        <div className="file-row">
          <FileAudio size={18} aria-hidden="true" />
          <span className="file-name" title={file.name}>
            {file.name}
          </span>
          <span className="file-size">{formatBytes(file.size)}</span>
          {!uploading && status.phase !== 'done' && (
            <Button
              variant="ghost"
              onClick={() => {
                pick(null)
                chooseRef.current?.focus()
              }}
              aria-label={t('upload.removeNamed', { name: file.name })}
            >
              <X size={16} aria-hidden="true" />
            </Button>
          )}
        </div>
      )}

      <div className="date-row">
        <div>
          <label htmlFor={dateId}>
            <strong>{t('upload.date')}</strong>
          </label>
          <p id={dateHelpId}>{t('upload.dateHelp')}</p>
        </div>
        <input
          id={dateId}
          type="datetime-local"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          disabled={uploading}
          aria-describedby={dateHelpId}
        />
      </div>

      {file && (status.phase === 'idle' || status.phase === 'error') && (
        <div className="record-actions">
          <Button variant="primary" onClick={start}>
            {t('upload.start')}
          </Button>
        </div>
      )}
      <UploadStatusView status={status} onRetry={status.phase === 'error' && status.resume ? () => void retryConfirm(status.resume!) : start} />
    </>
  )
}
