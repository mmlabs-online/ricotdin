// Version history of the summary or the notes (PRO-06, part 6b): a drawer on the right with the
// list (when, who, AI / edit / restore), a read-only preview and "Restore" for the owner and
// editors (confirmed in place). Everyone who can read the meeting sees the history and the
// editors' usernames (owner decision 2026-11-09); versions cannot be deleted one by one.
import { useEffect, useId, useRef, useState } from 'react'
import { History, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useRestoreVersion, useVersion, useVersions, type ContentField } from '../../api/meetingDetail'
import { contentHash } from '../../lib/meetings/edit'
import { historyErrorKey, versionLinks, type VersionRow } from '../../lib/meetings/history'
import { displayText } from '../../lib/text'
import { Markdown } from '../Markdown'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'

function useDateTime() {
  const { i18n } = useTranslation()
  const fmt = new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium', timeStyle: 'short' })
  return (iso: string) => fmt.format(new Date(iso))
}

function useHash(text: string | null) {
  const [hash, setHash] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void contentHash(text).then((h) => live && setHash(h))
    return () => {
      live = false
    }
  }, [text])
  return hash
}

function Who({ row }: { row: VersionRow }) {
  const { t } = useTranslation()
  if (row.source === 'ai') return <>{t('detail.history.source.ai')}</>
  const who = row.editedByUsername ? displayText(row.editedByUsername) : t('detail.history.unknownUser')
  return <>{t(row.source === 'restore' ? 'detail.history.source.restore' : 'detail.history.source.user', { who })}</>
}

export function VersionHistory({
  meetingId,
  field,
  current,
  canRestore,
  aiLinks,
  onClose,
  onRestored,
}: {
  meetingId: string
  field: ContentField
  /** the text shown now: restore is checked against it (409 if someone saved meanwhile) */
  current: string | null
  canRestore: boolean
  aiLinks?: readonly string[]
  onClose: () => void
  onRestored: () => void
}) {
  const { t } = useTranslation()
  const when = useDateTime()
  const list = useVersions(meetingId, field, true)
  const [selected, setSelected] = useState<string | null>(null)
  const version = useVersion(meetingId, selected)
  const restore = useRestoreVersion(meetingId)
  const currentHash = useHash(current)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<{ key: string; n: number } | null>(null)
  const previewRef = useRef<HTMLHeadingElement>(null)
  const confirmRef = useRef<HTMLParagraphElement>(null)
  const descId = useId()

  const rows = list.data ?? []
  const v = version.data
  const isCurrent = v !== undefined && currentHash !== null && v.contentHash === currentHash
  const row = rows.find((r) => r.id === selected)

  function pick(id: string) {
    setSelected(id)
    setConfirming(false)
    setError(null)
    requestAnimationFrame(() => previewRef.current?.focus())
  }

  async function doRestore() {
    if (!v || restore.isPending) return
    try {
      await restore.mutateAsync({ versionId: v.id, baseHash: await contentHash(current) })
      onRestored()
    } catch (err) {
      setConfirming(false)
      setError((prev) => ({ key: historyErrorKey(err), n: (prev?.n ?? 0) + 1 }))
    }
  }

  return (
    <Modal title={t(`detail.history.title.${field}`)} onClose={onClose} describedBy={descId} variant="drawer">
      <p id={descId} className="tab-note">
        {t('detail.history.help')}
      </p>
      {list.isPending ? (
        <p className="tab-note">{t('common.loading')}</p>
      ) : list.isError ? (
        <div className="tab-note">
          <p>{t(historyErrorKey(list.error))}</p>
          <Button onClick={() => void list.refetch()}>{t('common.tryAgain')}</Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="tab-note">{t('detail.history.empty')}</p>
      ) : (
        <ol className="version-list" aria-label={t('detail.history.listLabel')}>
          {rows.map((r) => (
            <li key={r.id}>
              <button type="button" className="version-row" aria-current={r.id === selected ? 'true' : undefined} onClick={() => pick(r.id)}>
                <span className="version-when">{when(r.createdAt)}</span>
                <span className="version-who">
                  <Who row={r} />
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}

      {selected && (
        <section className="version-preview" aria-labelledby={`${descId}-preview`}>
          <h3 id={`${descId}-preview`} ref={previewRef} tabIndex={-1}>
            {row ? t('detail.history.previewTitle', { when: when(row.createdAt) }) : t('detail.history.previewTitleNoDate')}
          </h3>
          {version.isPending ? (
            <p className="tab-note">{t('common.loading')}</p>
          ) : version.isError || !v ? (
            <div className="tab-note">
              <p>{t(historyErrorKey(version.error))}</p>
              <Button onClick={() => void version.refetch()}>{t('common.tryAgain')}</Button>
            </div>
          ) : (
            <>
              <div className="version-text">
                {v.content.trim() ? <Markdown source={v.content} links={versionLinks(v.source)} aiLinks={aiLinks} /> : <p className="tab-note">{t('detail.history.emptyText')}</p>}
              </div>
              {isCurrent ? (
                <p className="tab-note">{t('detail.history.isCurrent')}</p>
              ) : canRestore && !confirming ? (
                <div className="panel-footer">
                  <Button
                    onClick={() => {
                      setConfirming(true)
                      setError(null)
                      requestAnimationFrame(() => confirmRef.current?.focus())
                    }}
                    data-focus="restore"
                  >
                    <RotateCcw size={15} aria-hidden="true" />
                    {t('detail.history.restore')}
                  </Button>
                </div>
              ) : null}
              {confirming && (
                <div className="version-confirm" role="group" aria-labelledby={`${descId}-confirm`}>
                  <p id={`${descId}-confirm`} ref={confirmRef} tabIndex={-1}>
                    {t('detail.history.confirm')}
                  </p>
                  <div className="panel-footer">
                    <Button variant="primary" onClick={() => void doRestore()} aria-disabled={restore.isPending || undefined} aria-busy={restore.isPending}>
                      {restore.isPending ? t('detail.history.restoring') : t('detail.history.confirmAction')}
                    </Button>
                    <Button
                      onClick={() => {
                        setConfirming(false)
                        requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-focus="restore"]')?.focus())
                      }}
                    >
                      {t('common.cancel')}
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
          {error && (
            <p key={error.n} className="auth-error" role="alert">
              {t(error.key)}
            </p>
          )}
        </section>
      )}
    </Modal>
  )
}

export function HistoryButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button onClick={onClick} data-focus="history">
      <History size={15} aria-hidden="true" />
      {label}
    </Button>
  )
}
