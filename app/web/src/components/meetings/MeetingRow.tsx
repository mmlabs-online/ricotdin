import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { FileAudio, Folder as FolderIcon, Pin } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Meeting } from '../../api/meetings'
import { canDelete, canMove, canPin, canRename, type MeetingRole } from '../../lib/access/roles'
import { durationParts, statusKind } from '../../lib/meetings/list'
import { displayText } from '../../lib/text'
import { Status } from '../ui/Status'
import { RowMenu, type MenuItem } from './RowMenu'

export function MeetingRow({
  meeting,
  role,
  folderName,
  pinBusy,
  onPin,
  onRename,
  onMove,
  onDelete,
}: {
  meeting: Meeting
  role: MeetingRole
  folderName: string | null
  pinBusy: boolean
  onPin: () => void
  onRename: (title: string) => void
  onMove: () => void
  onDelete: () => void
}) {
  const { t, i18n } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(meeting.title)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuWrap = useRef<HTMLDivElement>(null)
  // One editing session ends once: Enter, blur (also the blur caused by moving focus) or Escape.
  const doneRef = useRef(false)

  useEffect(() => {
    if (!editing) return
    doneRef.current = false // a new editing session
    inputRef.current?.select()
  }, [editing])

  const when = new Date(meeting.started_at ?? meeting.created_at)
  const date = Number.isNaN(when.getTime())
    ? ''
    : new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium', timeStyle: 'short' }).format(when)
  const parts = durationParts(meeting.duration_seconds)
  const duration = parts
    ? parts.hours > 0
      ? t('meetings.duration.hm', { h: parts.hours, m: parts.minutes })
      : t('meetings.duration.m', { m: parts.minutes })
    : null
  const kind = statusKind(meeting.status)
  const title = displayText(meeting.title)
  const pinned = meeting.pinned_at !== null

  const finishEdit = (e?: FormEvent) => {
    e?.preventDefault()
    if (doneRef.current) return
    doneRef.current = true
    const title = draft.trim()
    setEditing(false)
    if (title && title !== meeting.title) onRename(title)
    // the menu trigger is the stable place to come back to
    menuWrap.current?.querySelector('button')?.focus()
  }

  function startRename() {
    setDraft(meeting.title)
    setEditing(true)
  }

  const items: MenuItem[] = []
  if (canRename(role)) items.push({ key: 'rename', label: t('meetings.actions.rename'), onSelect: startRename })
  if (canMove(role)) items.push({ key: 'move', label: t('meetings.actions.move'), onSelect: onMove })
  if (canDelete(role)) items.push({ key: 'delete', label: t('meetings.actions.delete'), onSelect: onDelete, danger: true })

  return (
    <article className="meeting-row">
      {canPin(role) ? (
        <button
          type="button"
          className={`pin ${pinned ? 'pinned' : ''}`}
          aria-label={pinned ? t('meetings.actions.unpin', { title }) : t('meetings.actions.pin', { title })}
          aria-pressed={pinned}
          disabled={pinBusy}
          onClick={onPin}
        >
          <Pin size={16} fill={pinned ? 'currentColor' : 'none'} aria-hidden="true" />
        </button>
      ) : (
        <span className={`pin ${pinned ? 'pinned' : ''}`} aria-hidden="true">
          {pinned && <Pin size={16} fill="currentColor" />}
        </span>
      )}
      <div className="meeting-icon" aria-hidden="true">
        <FileAudio size={19} />
      </div>
      <div className="meeting-primary">
        {editing ? (
          <form onSubmit={finishEdit}>
            <input
              ref={inputRef}
              className="rename-input"
              value={draft}
              maxLength={200}
              aria-label={t('meetings.actions.renameLabel')}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => finishEdit()}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  doneRef.current = true // the blur that follows must not save
                  setDraft(meeting.title)
                  setEditing(false)
                  menuWrap.current?.querySelector('button')?.focus()
                }
              }}
            />
          </form>
        ) : (
          <Link className="meeting-title" to={`/meetings/${encodeURIComponent(meeting.id)}`}>
            {title}
          </Link>
        )}
        <span>{duration ? `${date} · ${duration}` : date}</span>
      </div>
      <span className="folder-cell">
        {folderName && (
          <>
            <FolderIcon size={15} aria-hidden="true" /> {displayText(folderName)}
          </>
        )}
      </span>
      <span className="source">{t(`meetings.source.${meeting.source}`, { defaultValue: '' })}</span>
      <Status type={kind}>{t(`meetings.status.${kind}`)}</Status>
      <div ref={menuWrap}>
        <RowMenu label={t('meetings.actions.more', { title })} items={items} />
      </div>
    </article>
  )
}
