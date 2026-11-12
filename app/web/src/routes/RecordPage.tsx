// Record or upload (ARC-12): Figma Make "Record or upload" screen.
import { useCallback, useEffect, useId, useState } from 'react'
import { useBlocker } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useFolders } from '../api/meetings'
import { usePreferences } from '../api/profile'
import { FileUploadPanel } from '../components/FileUploadPanel'
import { Recorder } from '../components/Recorder'
import { assignableFolders, folderIdForUpload, initialFolderChoice } from '../lib/folders/defaultFolder'
import { displayText } from '../lib/text'
import { useDocumentTitle } from '../lib/useDocumentTitle'

export function RecordPage() {
  const { t } = useTranslation()
  useDocumentTitle('page.record.title')
  const [recBusy, setRecBusy] = useState(false)
  const [fileBusy, setFileBusy] = useState(false)
  const busy = recBusy || fileBusy
  const onRecBusy = useCallback((b: boolean) => setRecBusy(b), [])
  const onFileBusy = useCallback((b: boolean) => setFileBusy(b), [])
  // PRF-07: one folder choice for both the recorder and the file upload, starting on the default
  const prefs = usePreferences()
  const folders = useFolders()
  const [picked, setPicked] = useState<string | undefined>(undefined)
  const targets = folders.data ? assignableFolders(folders.data) : []
  // a picked folder that has since gone (deleted, share revoked) falls back to the default
  const stillThere = picked === '' || targets.some((f) => f.id === picked)
  const choice = picked !== undefined && stillThere ? picked : initialFolderChoice(prefs.data?.defaultFolderId, folders.data)
  const folderId = folderIdForUpload(choice)
  const folderSelect = useId()
  const folderHelp = useId()

  // Leaving inside the app (sidebar, back button) would unmount the recorder: ask first.
  const blocker = useBlocker(busy)
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    if (window.confirm(t('record.leaveConfirm'))) blocker.proceed()
    else blocker.reset()
  }, [blocker, t])

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
      {choice !== undefined && folders.data && (
        <div className="date-row folder-row">
          <div>
            <label htmlFor={folderSelect}>
              <strong>{t('upload.folder.label')}</strong>
            </label>
            <p id={folderHelp}>{t('upload.folder.help')}</p>
          </div>
          <select
            id={folderSelect}
            value={choice}
            onChange={(e) => setPicked(e.target.value)}
            disabled={busy}
            aria-describedby={folderHelp}
          >
            <option value="">{t('meetings.folders.none')}</option>
            {targets.map((f) => (
              <option key={f.id} value={f.id}>
                {f.myRole === 'owner' ? displayText(f.name) : `${displayText(f.name)} (${t('meetings.folders.shared')})`}
              </option>
            ))}
          </select>
        </div>
      )}
      <Recorder onBusyChange={onRecBusy} folderId={folderId} />
      <div className="or">
        <span>{t('upload.or')}</span>
      </div>
      <FileUploadPanel onBusyChange={onFileBusy} folderId={folderId} />
    </div>
  )
}
