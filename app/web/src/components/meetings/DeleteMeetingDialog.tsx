import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'

export function DeleteMeetingDialog({
  title,
  busy,
  onConfirm,
  onClose,
}: {
  title: string
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const bodyId = useId()
  return (
    <Modal title={t('meetings.delete.title')} onClose={onClose} describedBy={bodyId}>
      <p className="modal-copy" id={bodyId}>{t('meetings.delete.body', { title })}</p>
      <div className="modal-actions">
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button variant="danger" onClick={() => !busy && onConfirm()} aria-disabled={busy} aria-busy={busy}>
          {t('meetings.delete.confirm')}
        </Button>
      </div>
    </Modal>
  )
}
