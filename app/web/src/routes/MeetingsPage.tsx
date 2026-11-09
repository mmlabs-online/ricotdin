// Meetings list (ARC-13a; MMG-01..04, PRP-07), Figma Make MeetingsView.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { ArrowUpRight, FileAudio, FolderCog, Mic2, Search, Sparkles, Upload, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '../api/errors'
import {
  useDeleteMeeting,
  useFolders,
  useMeetings,
  useMoveMeeting,
  usePinMeeting,
  usePinsInFlight,
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
import { displayText, isInvisibleCharactersError } from '../lib/text'
import { useDocumentTitle } from '../lib/useDocumentTitle'

function errorKey(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'network') return 'errors.network'
    if (isInvisibleCharactersError(err)) return 'errors.invisibleCharacters' // SEC-05 (rename)
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
  const pinsInFlight = usePinsInFlight()
  const rename = useRenameMeeting()
  const move = useMoveMeeting()
  const del = useDeleteMeeting()
  const [search, setSearch] = useState('')
  const [folder, setFolder] = useState<FolderFilter>('all')
  const [moving, setMoving] = useState<Meeting | null>(null)
  const [deleting, setDeleting] = useState<Meeting | null>(null)
  const [managing, setManaging] = useState(false)
  // A meeting deleted from its detail page reports here (router state, not the URL).
  const arrived = (useLocation().state as { notice?: unknown } | null)?.notice
  const [notice, setNotice] = useState<{ key: string; kind: 'error' | 'warning' | 'success' } | null>(() =>
    arrived === 'warning'
      ? { key: 'meetings.delete.warning', kind: 'warning' }
      : arrived === 'deleted'
        ? { key: 'meetings.delete.done', kind: 'success' }
        : null,
  )
  const navigate = useNavigate()
  useEffect(() => {
    if (arrived) void navigate('.', { replace: true, state: null }) // a reload must not repeat it
  }, [arrived, navigate])

  const folderList = useMemo(() => folders.data ?? [], [folders.data])
  const byId = useMemo(() => new Map(folderList.map((f) => [f.id, f])), [folderList])
  // A deleted or unshared folder must not keep the list filtered on nothing.
  const activeFolder: FolderFilter =
    folder === 'all' || folder === 'none' || !folders.data || byId.has(folder) ? folder : 'all'
  const list = useMemo(
    () => filterMeetings(meetings.data ?? [], { search, folder: activeFolder }),
    [meetings.data, search, activeFolder],
  )
  const doneCount = (meetings.data ?? []).filter((m) => m.status === 'done').length
  const fail = (err: unknown) => setNotice({ key: errorKey(err), kind: 'error' })
  const headingRef = useRef<HTMLHeadingElement>(null)
  // A re-sorted row (pin) may lose focus when React moves it: put it back on the same pin.
  const refocusPin = useRef<string | null>(null)
  useEffect(() => {
    const id = refocusPin.current
    if (!id) return
    if (document.activeElement && document.activeElement !== document.body) return // focus is somewhere on purpose
    document.querySelector<HTMLElement>(`[data-pin="${CSS.escape(id)}"]`)?.focus()
  })


  if (meetings.isPending) return <FullPageLoading />

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">{t('page.workspace')}</span>
          <h1 ref={headingRef} tabIndex={-1}>
            {t('page.meetings.title')}
          </h1>
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

      {/* always present, so screen readers announce the text that appears in it */}
      <p className="sr-only" role="status">
        {notice && notice.kind !== 'error' ? t(notice.key) : ''}
      </p>
      {notice && (
        <div className={`notice-banner ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : undefined}>
          <span>{t(notice.key)}</span>
          <Button variant="ghost" onClick={() => setNotice(null)} aria-label={t('common.dismiss')}>
            <X size={16} aria-hidden="true" />
          </Button>
        </div>
      )}

      {folders.isError && (
        <div className="notice-banner warning" role="status">
          <span>{t('meetings.folders.loadError')}</span>
          <Button variant="ghost" onClick={() => void folders.refetch()}>
            {t('common.tryAgain')}
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
            ...folderList.map((f) => ({ id: f.id, name: displayText(f.name), shared: f.myRole !== 'owner' || f.memberCount > 0 })),
            { id: 'none', name: t('meetings.folders.none'), shared: false },
          ].map((f) => (
            <button
              key={f.id}
              type="button"
              className={activeFolder === f.id ? 'active' : ''}
              aria-pressed={activeFolder === f.id}
              onClick={() => setFolder(f.id)}
            >
              {f.name}
              {f.shared && (
                <>
                  {' '}
                  <span className="tiny-shared">{t('meetings.folders.shared')}</span>
                </>
              )}
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
                  pinBusy={pinsInFlight.has(m.id)}
                  onPin={() => {
                    refocusPin.current = m.id
                    pin.mutate(
                      { id: m.id, pinned: m.pinned_at === null },
                      {
                        onError: fail,
                        onSettled: () =>
                          requestAnimationFrame(() => {
                            if (refocusPin.current === m.id) refocusPin.current = null
                          }),
                      },
                    )
                  }}
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
          title={displayText(moving.title)}
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
          title={displayText(deleting.title)}
          busy={del.isPending}
          onClose={() => setDeleting(null)}
          onConfirm={() =>
            del.mutate(deleting.id, {
              onSuccess: (res) =>
                setNotice(res.warning ? { key: 'meetings.delete.warning', kind: 'warning' } : { key: 'meetings.delete.done', kind: 'success' }),
              onError: fail,
              onSettled: () => {
                setDeleting(null)
                // the row (and its menu button) is gone: continue from the page heading
                requestAnimationFrame(() => headingRef.current?.focus())
              },
            })
          }
        />
      )}
      {managing && <FoldersDialog meetings={meetings.data ?? []} onClose={() => setManaging(false)} />}
    </>
  )
}
