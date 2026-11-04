// Meetings list (ARC-13a; MMG-01..04, PRP-07), Figma Make MeetingsView.
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { ArrowUpRight, FileAudio, FolderCog, Mic2, Search, Sparkles, Upload, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '../api/errors'
import {
  useDeleteMeeting,
  useFolders,
  useMeetings,
  useMoveMeeting,
  usePinMeeting,
  useRenameMeeting,
  type Meeting,
} from '../api/meetings'
import { useAuth } from '../auth/AuthProvider'
import { FoldersDialog } from '../components/folders/FoldersDialog'
import { DeleteMeetingDialog } from '../components/meetings/DeleteMeetingDialog'
import { MeetingRow } from '../components/meetings/MeetingRow'
import { MoveDialog } from '../components/meetings/MoveDialog'
import { FullPageLoading } from '../components/FullPageLoading'
import { Button } from '../components/ui/Button'
import { getMeetingRole } from '../lib/access/roles'
import { filterMeetings, type FolderFilter } from '../lib/meetings/list'
import { useDocumentTitle } from '../lib/useDocumentTitle'

function errorKey(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'network') return 'errors.network'
    if (err.status === 403) return 'errors.forbidden'
    if (err.status === 404) return 'errors.notFound'
    if (err.status === 429) return 'errors.rateLimited'
  }
  return 'errors.generic'
}

export function MeetingsPage() {
  const { t } = useTranslation()
  useDocumentTitle('page.meetings.title')
  const { state } = useAuth()
  const me = state.status === 'signedIn' ? state.user.id : ''
  const meetings = useMeetings()
  const folders = useFolders()
  const pin = usePinMeeting()
  const rename = useRenameMeeting()
  const move = useMoveMeeting()
  const del = useDeleteMeeting()
  const [search, setSearch] = useState('')
  const [folder, setFolder] = useState<FolderFilter>('all')
  const [moving, setMoving] = useState<Meeting | null>(null)
  const [deleting, setDeleting] = useState<Meeting | null>(null)
  const [managing, setManaging] = useState(false)
  const [notice, setNotice] = useState<{ key: string; kind: 'error' | 'warning' | 'success' } | null>(null)

  const folderList = useMemo(() => folders.data ?? [], [folders.data])
  const byId = useMemo(() => new Map(folderList.map((f) => [f.id, f])), [folderList])
  const list = useMemo(() => filterMeetings(meetings.data ?? [], { search, folder }), [meetings.data, search, folder])
  const doneCount = (meetings.data ?? []).filter((m) => m.status === 'done').length
  const fail = (err: unknown) => setNotice({ key: errorKey(err), kind: 'error' })

  if (meetings.isPending) return <FullPageLoading />

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">{t('page.workspace')}</span>
          <h1>{t('page.meetings.title')}</h1>
          <p>{t('page.meetings.subtitle')}</p>
        </div>
        <div className="head-actions">
          <Link className="button button-secondary" to="/record">
            <Upload size={16} aria-hidden="true" /> {t('meetings.upload')}
          </Link>
          <Link className="button button-primary" to="/record">
            <Mic2 size={16} aria-hidden="true" /> {t('meetings.record')}
          </Link>
        </div>
      </div>

      {doneCount > 0 && (
        <section className="insight">
          <div className="insight-icon" aria-hidden="true">
            <Sparkles size={20} />
          </div>
          <div>
            <strong>{t('meetings.insight.title')}</strong>
            <p>{t('meetings.insight.body', { count: doneCount })}</p>
          </div>
          <Link className="button button-ghost" to="/chat">
            {t('meetings.insight.cta')} <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
        </section>
      )}

      {notice && (
        <div className={`notice-banner ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
          <span>{t(notice.key)}</span>
          <Button variant="ghost" onClick={() => setNotice(null)} aria-label={t('common.dismiss')}>
            <X size={16} aria-hidden="true" />
          </Button>
        </div>
      )}

      <div className="toolbar">
        <label className="search">
          <Search size={18} aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('meetings.search')}
            aria-label={t('meetings.search')}
          />
        </label>
        <div className="folder-pills" role="group" aria-label={t('meetings.folders.filter')}>
          {[
            { id: 'all', name: t('meetings.folders.all'), shared: false },
            ...folderList.map((f) => ({ id: f.id, name: f.name, shared: f.myRole !== 'owner' || f.memberCount > 0 })),
            { id: 'none', name: t('meetings.folders.none'), shared: false },
          ].map((f) => (
            <button
              key={f.id}
              type="button"
              className={folder === f.id ? 'active' : ''}
              aria-pressed={folder === f.id}
              onClick={() => setFolder(f.id)}
            >
              {f.name}
              {f.shared && <span className="tiny-shared">{t('meetings.folders.shared')}</span>}
            </button>
          ))}
          <Button variant="ghost" onClick={() => setManaging(true)}>
            <FolderCog size={17} aria-hidden="true" /> {t('meetings.folders.manage')}
          </Button>
        </div>
      </div>

      {meetings.isError ? (
        <div className="empty" role="alert">
          <p>{t(errorKey(meetings.error))}</p>
          <Button onClick={() => void meetings.refetch()}>{t('common.tryAgain')}</Button>
        </div>
      ) : (
        <>
          <div className="list-head">
            <span aria-live="polite">{t('meetings.count', { count: list.length })}</span>
          </div>
          <div className="meeting-list">
            {list.length === 0 ? (
              <div className="empty">
                <div className="empty-icon" aria-hidden="true">
                  <FileAudio />
                </div>
                <h2>{(meetings.data ?? []).length === 0 ? t('meetings.empty.first') : t('meetings.empty.title')}</h2>
                <p>{(meetings.data ?? []).length === 0 ? t('meetings.empty.firstBody') : t('meetings.empty.body')}</p>
                <Link className="button button-primary" to="/record">
                  {t('meetings.record')}
                </Link>
              </div>
            ) : (
              list.map((m) => (
                <MeetingRow
                  key={m.id}
                  meeting={m}
                  role={getMeetingRole(m, me, folderList)}
                  folderName={m.folder_id ? (byId.get(m.folder_id)?.name ?? null) : null}
                  pinBusy={pin.isPending && pin.variables?.id === m.id}
                  onPin={() => pin.mutate({ id: m.id, pinned: m.pinned_at === null }, { onError: fail })}
                  onRename={(title) => rename.mutate({ id: m.id, title }, { onError: fail })}
                  onMove={() => setMoving(m)}
                  onDelete={() => setDeleting(m)}
                />
              ))
            )}
          </div>
        </>
      )}

      {moving && (
        <MoveDialog
          title={moving.title}
          current={moving.folder_id}
          folders={folderList}
          onClose={() => setMoving(null)}
          onMove={(folderId) => {
            move.mutate({ id: moving.id, folderId }, { onError: fail })
            setMoving(null)
          }}
        />
      )}
      {deleting && (
        <DeleteMeetingDialog
          title={deleting.title}
          busy={del.isPending}
          onClose={() => setDeleting(null)}
          onConfirm={() =>
            del.mutate(deleting.id, {
              onSuccess: (res) =>
                setNotice(res.warning ? { key: 'meetings.delete.warning', kind: 'warning' } : { key: 'meetings.delete.done', kind: 'success' }),
              onError: fail,
              onSettled: () => setDeleting(null),
            })
          }
        />
      )}
      {managing && <FoldersDialog meetings={meetings.data ?? []} onClose={() => setManaging(false)} />}
    </>
  )
}
