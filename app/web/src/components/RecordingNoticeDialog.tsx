// COM-01 recording notice (Figma Make "Recording notice" modal). Recording starts only from the
// confirm click, synchronously, so the browser's capture prompts keep the user activation.
import { useId } from 'react'
import { Mic2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/Button'
import { Modal } from './ui/Modal'

export function RecordingNoticeDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const { t } = useTranslation()
  const bodyId = useId()
  const scriptId = useId()
  return (
    <Modal title={t('record.notice.title')} onClose={onCancel} describedBy={`${bodyId} ${scriptId}`}>
      <div className="notice-icon" aria-hidden="true">
        <Mic2 />
      </div>
      <p id={bodyId} className="modal-copy">
        {t('record.notice.body')}
      </p>
      <div className="script">
        <span className="eyebrow">{t('record.notice.scriptLabel')}</span>
        <p id={scriptId}>{t('record.notice.script')}</p>
      </div>
      <div className="modal-actions">
        <Button variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" onClick={onConfirm}>
          <Mic2 size={16} aria-hidden="true" /> {t('record.notice.confirm')}
        </Button>
      </div>
    </Modal>
  )
}
