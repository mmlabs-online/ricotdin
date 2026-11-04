import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Folder } from '../../api/meetings'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'

/** Move a meeting (owner only) to "No folder" or to a folder the caller owns or edits. */
export function MoveDialog({
  title,
  current,
  folders,
  onMove,
  onClose,
}: {
  title: string
  current: string | null
  folders: Folder[]
  onMove: (folderId: string | null) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const name = useId()
  const [choice, setChoice] = useState<string>(current ?? '')
  const targets = folders.filter((f) => f.myRole === 'owner' || f.myRole === 'editor')
  return (
    <Modal title={t('meetings.move.title', { title })} onClose={onClose}>
      <fieldset className="choice-list">
        <legend className="sr-only">{t('meetings.move.legend')}</legend>
        <label>
          <input type="radio" name={name} value="" checked={choice === ''} onChange={() => setChoice('')} />
          {t('meetings.folders.none')}
        </label>
        {targets.map((f) => (
          <label key={f.id}>
            <input type="radio" name={name} value={f.id} checked={choice === f.id} onChange={() => setChoice(f.id)} />
            {f.name}
            {f.myRole !== 'owner' && <span className="badge">{t('meetings.folders.shared')}</span>}
          </label>
        ))}
      </fieldset>
      <div className="modal-actions">
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" disabled={choice === (current ?? '')} onClick={() => onMove(choice || null)}>
          {t('meetings.move.confirm')}
        </Button>
      </div>
    </Modal>
  )
}
