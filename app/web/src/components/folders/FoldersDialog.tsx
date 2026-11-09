// Manage folders (ARC-13a; COM-05), Figma Make "Manage folders" modal: create, rename, reorder
// (up / down buttons instead of drag and drop: keyboard friendly), delete with the v1 notices
// (BUG-014..016), shared-with-me list, and the share panel of an own folder.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, Folder as FolderIcon, Pencil, Plus, Trash2, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '../../api/errors'
import {
  useCreateFolder,
  useDeleteFolder,
  useFolders,
  useRenameFolder,
  useReorderFolders,
  type Folder,
  type Meeting,
} from '../../api/meetings'
import { useAuth } from '../../auth/AuthProvider'
import { folderDeleteChatNotice, folderDeleteCounts } from '../../lib/folders/deleteNotice'
import { displayText, isInvisibleCharactersError } from '../../lib/text'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'
import { SharePanel } from './SharePanel'

const MAX_NAME = 100

export function folderErrorKey(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'network') return 'errors.network'
    if (isInvisibleCharactersError(err)) return 'errors.invisibleCharacters' // SEC-05
    if (err.status === 409) return 'folders.errors.duplicate'
    if (err.status === 400 || err.status === 422) return 'folders.errors.name'
    if (err.status === 403 || err.status === 404) return 'errors.forbidden'
    if (err.status === 429) return 'errors.rateLimited'
  }
  return 'errors.generic'
}

export function FoldersDialog({ meetings, onClose }: { meetings: Meeting[]; onClose: () => void }) {
  const { t } = useTranslation()
  const { state } = useAuth()
  const me = state.status === 'signedIn' ? state.user.id : ''
  const folders = useFolders()
  const create = useCreateFolder()
  const rename = useRenameFolder()
  const reorder = useReorderFolders()
  const remove = useDeleteFolder(me)
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState<Folder | null>(null)
  const [alsoMeetings, setAlsoMeetings] = useState(false)
  const [sharing, setSharing] = useState<Folder | null>(null)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  // Controls that disappear (rename input, delete view, share panel) hand focus to a stable one.
  const focusAfter = useRef<string | null>(null)
  useEffect(() => {
    if (!focusAfter.current) return
    const el = document.querySelector<HTMLElement>(focusAfter.current)
    if (el) {
      el.focus()
      focusAfter.current = null
    }
  })

  const all = folders.data ?? []
  const own = all.filter((f) => f.myRole === 'owner')
  const shared = all.filter((f) => f.myRole !== 'owner')
  const fail = (err: unknown) => setErrorKey(folderErrorKey(err))

  const onCreate = (e: FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    setErrorKey(null)
    create.mutate(n, { onSuccess: () => setName(''), onError: fail })
  }
  const onRename = (e: FormEvent) => {
    e.preventDefault()
    if (!editing) return
    const n = editing.name.trim()
    const before = own.find((f) => f.id === editing.id)?.name
    focusAfter.current = `[data-rename="${CSS.escape(editing.id)}"]`
    setEditing(null)
    if (n && n !== before) rename.mutate({ id: editing.id, name: n }, { onError: fail })
  }
  const moveBy = (index: number, delta: number) => {
    const ids = own.map((f) => f.id)
    const j = index + delta
    if (reorder.isPending || j < 0 || j >= ids.length) return
    const moved = own[index]!
    ;[ids[index], ids[j]] = [ids[j]!, ids[index]!]
    // keep focus on the same arrow of the moved folder (the other arrow once it reaches the edge)
    const atEdge = (delta < 0 && j === 0) || (delta > 0 && j === ids.length - 1)
    const dir = (delta < 0) !== atEdge ? 'up' : 'down'
    focusAfter.current = `[data-move="${CSS.escape(moved.id)}-${dir}"]`
    reorder.mutate(ids, {
      onSuccess: () => setStatus(t('folders.moved', { name: displayText(moved.name), pos: j + 1, total: ids.length })),
      onError: fail,
    })
  }

  if (sharing) {
    const back = () => {
      focusAfter.current = `[data-share="${CSS.escape(sharing.id)}"]`
      setSharing(null)
    }
    return <SharePanel folder={sharing} onBack={back} />
  }
  const leaveDelete = (target: string) => {
    focusAfter.current = target
    setDeleting(null)
  }

  if (deleting) {
    const counts = folderDeleteCounts(meetings, deleting.id, me)
    const chat = folderDeleteChatNotice(deleting.memberCount)
    return (
      <Modal
        key="delete"
        title={t('folders.delete.title', { name: displayText(deleting.name) })}
        onClose={() => leaveDelete(`[data-delete="${CSS.escape(deleting.id)}"]`)}
      >
        <p className="modal-copy">{t(chat.key, { count: chat.count })}</p>
        {counts.total > 0 && (
          <label className="check-row">
            <input type="checkbox" checked={alsoMeetings} onChange={(e) => setAlsoMeetings(e.target.checked)} disabled={counts.deletable === 0} />
            <span>
              {t('folders.delete.alsoMeetings', { count: counts.deletable })}
              {counts.othersMoved > 0 && <small>{t('folders.delete.othersMoved', { count: counts.othersMoved })}</small>}
            </span>
          </label>
        )}
        <p className="modal-copy">{alsoMeetings ? t('folders.delete.meetingsGone') : t('folders.delete.meetingsKept')}</p>
        {errorKey && (
          <p className="notice-banner error" role="alert">
            {t(errorKey)}
          </p>
        )}
        <div className="modal-actions">
          <Button variant="ghost" onClick={() => leaveDelete(`[data-delete="${CSS.escape(deleting.id)}"]`)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(
                { id: deleting.id, deleteMeetings: alsoMeetings && counts.deletable > 0 },
                {
                  onSuccess: () => {
                    setStatus(t('folders.deleted', { name: displayText(deleting.name) }))
                    leaveDelete('[data-new-folder]')
                  },
                  onError: fail,
                },
              )
            }
          >
            {t('folders.delete.confirm')}
          </Button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal key="list" title={t('folders.title')} onClose={onClose}>
      <p className="sr-only" role="status">
        {status}
      </p>
      {errorKey && (
        <p className="notice-banner error" role="alert">
          {t(errorKey)}
        </p>
      )}
      {own.length === 0 ? (
        <p className="modal-copy">{t('folders.empty')}</p>
      ) : (
        <ul className="modal-list" aria-label={t('folders.mine')}>
          {own.map((f, i) => (
            <li className="folder-row" key={f.id}>
              <FolderIcon size={17} aria-hidden="true" />
              {editing?.id === f.id ? (
                <form className="folder-rename" onSubmit={onRename}>
                  <input
                    autoFocus
                    value={editing.name}
                    maxLength={MAX_NAME}
                    aria-label={t('folders.renameLabel', { name: displayText(f.name) })}
                    onChange={(e) => setEditing({ id: f.id, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        e.stopPropagation()
                        focusAfter.current = `[data-rename="${CSS.escape(f.id)}"]`
                        setEditing(null)
                      }
                    }}
                  />
                  <Button type="submit" variant="primary">
                    {t('common.save')}
                  </Button>
                </form>
              ) : (
                <span className="folder-name">{displayText(f.name)}</span>
              )}
              {f.memberCount > 0 && <span className="badge">{t('folders.members', { count: f.memberCount })}</span>}
              <span className="folder-actions">
                <Button
                  variant="ghost"
                  data-move={`${f.id}-up`}
                  aria-label={t('folders.up', { name: displayText(f.name) })}
                  aria-disabled={i === 0 || reorder.isPending || undefined}
                  onClick={() => moveBy(i, -1)}
                >
                  <ArrowUp size={16} aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  data-move={`${f.id}-down`}
                  aria-label={t('folders.down', { name: displayText(f.name) })}
                  aria-disabled={i === own.length - 1 || reorder.isPending || undefined}
                  onClick={() => moveBy(i, 1)}
                >
                  <ArrowDown size={16} aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  data-rename={f.id}
                  aria-label={t('folders.rename', { name: displayText(f.name) })}
                  onClick={() => setEditing({ id: f.id, name: f.name })}
                >
                  <Pencil size={16} aria-hidden="true" />
                </Button>
                <Button variant="ghost" data-share={f.id} aria-label={t('folders.shareLabel', { name: displayText(f.name) })} onClick={() => setSharing(f)}>
                  <Users size={16} aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  data-delete={f.id}
                  aria-label={t('folders.deleteLabel', { name: displayText(f.name) })}
                  onClick={() => {
                    setAlsoMeetings(false)
                    setErrorKey(null)
                    setDeleting(f)
                  }}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form className="inline" onSubmit={onCreate}>
        <input
          data-new-folder
          value={name}
          maxLength={MAX_NAME}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('folders.newPlaceholder')}
          aria-label={t('folders.newLabel')}
        />
        <Button type="submit" variant="primary" disabled={!name.trim() || create.isPending}>
          <Plus size={16} aria-hidden="true" /> {t('folders.create')}
        </Button>
      </form>
      {shared.length > 0 && (
        <div className="share-box">
          <span className="eyebrow">{t('folders.sharedWithMe')}</span>
          <ul className="plain-list">
            {shared.map((f) => (
              <li key={f.id}>
                <FolderIcon size={15} aria-hidden="true" /> <bdi>{displayText(f.name)}</bdi>{' '}
                <small>{t('folders.sharedBy', { owner: f.ownerUsername ?? '—', role: t(`folders.roles.${f.myRole}`) })}</small>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  )
}
