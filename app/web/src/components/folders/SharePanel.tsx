import { useState, type FormEvent } from 'react'
import { ArrowLeft, UserMinus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '../../api/errors'
import { useShareMutations, useShares, type Folder } from '../../api/meetings'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'
import { displayText } from '../../lib/text'

function shareErrorKey(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'network') return 'errors.network'
    if (err.status === 404) return 'folders.share.notFound'
    if (err.status === 409) return 'folders.share.conflict'
    if (err.status === 422) return 'folders.share.invalid'
    if (err.status === 429) return 'errors.rateLimited'
    if (err.status === 403) return 'errors.forbidden'
  }
  return 'errors.generic'
}

/** Share an own folder by email or username; change or remove members. */
export function SharePanel({ folder, onBack, onClose }: { folder: Folder; onBack: () => void; onClose: () => void }) {
  const { t } = useTranslation()
  const members = useShares(folder.id)
  const { add, change, remove } = useShareMutations(folder.id)
  const [identifier, setIdentifier] = useState('')
  const [role, setRole] = useState<'viewer' | 'editor'>('viewer')
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [added, setAdded] = useState<{ username: string; role: 'editor' | 'viewer' } | null>(null)
  const fail = (err: unknown) => {
    setAdded(null)
    setErrorKey(shareErrorKey(err))
  }

  const invite = (e: FormEvent) => {
    e.preventDefault()
    const id = identifier.trim()
    if (!id) return
    setErrorKey(null)
    add.mutate(
      { identifier: id, role },
      {
        onSuccess: (res) => {
          setIdentifier('')
          const member = (res as { member?: { username?: unknown; role?: unknown } } | null)?.member
          // Show WHO got access: a mistyped / look-alike email is caught here (CWE-451).
          setAdded({ username: typeof member?.username === 'string' ? member.username : id, role })
        },
        onError: fail,
      },
    )
  }

  return (
    <Modal title={t('folders.share.title', { name: displayText(folder.name) })} onClose={onClose}>
      <Button variant="ghost" onClick={onBack}>
        <ArrowLeft size={16} aria-hidden="true" /> {t('folders.share.back')}
      </Button>
      <p className="modal-copy">{t('folders.share.help')}</p>
      {members.isPending ? (
        <p className="modal-copy">{t('app.loading')}</p>
      ) : (members.data ?? []).length === 0 ? (
        <p className="modal-copy">{t('folders.share.none')}</p>
      ) : (
        <ul className="modal-list" aria-label={t('folders.share.members')}>
          {(members.data ?? []).map((m) => (
            <li className="folder-row" key={m.userId}>
              <span className="folder-name">{m.username}</span>
              <select
                value={m.role}
                aria-label={t('folders.share.roleFor', { name: m.username })}
                onChange={(e) => change.mutate({ userId: m.userId, role: e.target.value as 'viewer' | 'editor' }, { onError: fail })}
              >
                <option value="viewer">{t('folders.roles.viewer')}</option>
                <option value="editor">{t('folders.roles.editor')}</option>
              </select>
              <Button variant="ghost" aria-label={t('folders.share.remove', { name: m.username })} onClick={() => remove.mutate(m.userId, { onError: fail })}>
                <UserMinus size={16} aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form className="share-box" onSubmit={invite}>
        <span className="eyebrow">{t('folders.share.invite')}</span>
        <div className="inline">
          <input
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder={t('folders.share.placeholder')}
            aria-label={t('folders.share.identifier')}
            maxLength={320}
          />
          <select value={role} onChange={(e) => setRole(e.target.value as 'viewer' | 'editor')} aria-label={t('folders.share.role')}>
            <option value="viewer">{t('folders.roles.viewer')}</option>
            <option value="editor">{t('folders.roles.editor')}</option>
          </select>
          <Button type="submit" variant="primary" disabled={!identifier.trim() || add.isPending}>
            {t('folders.share.inviteButton')}
          </Button>
        </div>
        <p className="modal-copy">{t('folders.share.roleHelp')}</p>
      </form>
      <p className={added ? 'notice-banner success' : 'sr-only'} role="status">
        {added ? t('folders.share.addedWho', { name: added.username, role: t(`folders.roles.${added.role}`) }) : ''}
      </p>
      {errorKey && (
        <p className="notice-banner error" role="alert">
          {t(errorKey)}
        </p>
      )}
    </Modal>
  )
}
