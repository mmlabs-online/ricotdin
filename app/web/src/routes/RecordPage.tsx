// Record or upload (ARC-12): Figma Make "Record or upload" screen.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileUploadPanel } from '../components/FileUploadPanel'
import { Recorder } from '../components/Recorder'
import { useDocumentTitle } from '../lib/useDocumentTitle'

export function RecordPage() {
  const { t } = useTranslation()
  useDocumentTitle('page.record.title')
  const [recBusy, setRecBusy] = useState(false)
  const [fileBusy, setFileBusy] = useState(false)
  const busy = recBusy || fileBusy
  const onRecBusy = useCallback((b: boolean) => setRecBusy(b), [])
  const onFileBusy = useCallback((b: boolean) => setFileBusy(b), [])

  // Leaving while recording or uploading loses the recording: ask first.
  useEffect(() => {
    if (!busy) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [busy])

  return (
    <div className="narrow">
      <div className="page-head">
        <div>
          <span className="eyebrow">{t('page.record.eyebrow')}</span>
          <h1>{t('page.record.title')}</h1>
          <p>{t('page.record.subtitle')}</p>
        </div>
      </div>
      <Recorder onBusyChange={onRecBusy} />
      <div className="or">
        <span>{t('upload.or')}</span>
      </div>
      <FileUploadPanel onBusyChange={onFileBusy} />
    </div>
  )
}
