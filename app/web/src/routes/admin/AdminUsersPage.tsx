// Admin › Users (ARC-14a, Make UsersAdmin): search, usage month, bulk disable / enable / role.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router'
import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAdminUsers, useUserMutations, type AdminUserRow } from '../../api/admin/users'
import { useAuth } from '../../auth/AuthProvider'
import { AdminHead, NoticeBanner, UserStatusBadge, useFormatters, useNotice } from '../../components/admin/AdminParts'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import { adminErrorKey, BULK_MAX, bulkSummary, monthValue } from '../../lib/admin/users'
import { quotaParts } from '../../lib/profile/profile'
import { displayText } from '../../lib/text'
import { useDocumentTitle } from '../../lib/useDocumentTitle'

const PER_PAGE = 20
type Bulk = { action: 'disable' | 'enable' | 'set_role'; role?: 'user' | 'admin' }

export function AdminUsersPage() {
  const { t } = useTranslation()
  useDocumentTitle('admin.tabs.users')
  const { state } = useAuth()
  const me = state.status === 'signedIn' ? state.user.id : ''
  // page, search and month live in the URL, so Back from a user detail returns to the same list
  const [params, setParams] = useSearchParams()
  const [thisMonth] = useState(() => monthValue(new Date()) ?? '')
  const page = Math.max(1, Math.min(10_000, Number.parseInt(params.get('page') ?? '', 10) || 1))
  const search = (params.get('q') ?? '').slice(0, 200)
  const month = monthValue(params.get('month') ?? '') ?? thisMonth
  const setList = (next: { page?: number; q?: string; month?: string }) => {
    const p = new URLSearchParams(params)
    const put = (k: string, v: string | undefined, empty: string) => (v === undefined ? undefined : v === empty ? p.delete(k) : p.set(k, v))
    put('page', next.page === undefined ? undefined : String(next.page), '1')
    put('q', next.q, '')
    put('month', next.month, thisMonth)
    setParams(p, { replace: true, preventScrollReset: true })
  }
  const [draft, setDraft] = useState(search)
  const [monthDraft, setMonthDraft] = useState(month)
  // selected ids → email (shown in the confirm), kept only for the list they were picked on
  const listKey = `${page}|${search}|${month}`
  const [picked, setPicked] = useState<{ key: string; ids: Map<string, string> }>({ key: listKey, ids: new Map() })
  const selected = picked.key === listKey ? picked.ids : new Map<string, string>()
  const setSelected = (next: Map<string, string> | ((prev: Map<string, string>) => Map<string, string>)) =>
    setPicked((p) => ({ key: listKey, ids: typeof next === 'function' ? next(p.key === listKey ? p.ids : new Map()) : next }))
  // the URL changed (Back, a link): show its values in the fields
  const [shown, setShown] = useState({ search, month })
  if (shown.search !== search || shown.month !== month) {
    setShown({ search, month })
    setDraft(search)
    setMonthDraft(month)
  }
  const [bulk, setBulk] = useState<Bulk | null>(null)
  const [notice, setNotice] = useNotice()
  // a user deleted from the detail page reports here (router state, cleared so a reload is quiet)
  const location = useLocation()
  const navigate = useNavigate()
  const arrived = (location.state as { notice?: unknown } | null)?.notice
  useEffect(() => {
    if (arrived !== 'deleted' && arrived !== 'deletedWarning') return
    setNotice(arrived === 'deleted' ? 'admin.users.deleted' : 'admin.users.deletedWarning', arrived === 'deleted' ? 'success' : 'warning')
    void navigate({ search: location.search }, { replace: true, state: null })
  }, [arrived, navigate]) // eslint-disable-line react-hooks/exhaustive-deps
  const list = useAdminUsers({ page, perPage: PER_PAGE, search, month })
  const { bulk: bulkMutation } = useUserMutations()
  const f = useFormatters()
  const ids = { search: useId(), month: useId(), all: useId(), caption: useId(), bulkBody: useId() }
  const allRef = useRef<HTMLInputElement>(null)

  const users = list.data?.users ?? []
  const total = list.data?.total ?? 0
  const selectable = users.filter((u) => u.id !== me)
  const allChecked = selectable.length > 0 && selectable.every((u) => selected.has(u.id))
  const someChecked = !allChecked && selectable.some((u) => selected.has(u.id))
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = someChecked
  })
  const focusList = () => requestAnimationFrame(() => document.getElementById(ids.all)?.focus())
  const bulkBusy = bulkMutation.isPending
  // a page past the end (users removed meanwhile): go to the last one
  const lastPage = Math.max(1, Math.ceil(total / PER_PAGE))
  useEffect(() => {
    if (list.data && page > lastPage) setList({ page: lastPage })
  }, [list.data, page, lastPage]) // eslint-disable-line react-hooks/exhaustive-deps

  function submitSearch(e: FormEvent) {
    e.preventDefault()
    setList({ q: draft.trim(), page: 1 })
  }

  function applyMonth(v: string) {
    const m = monthValue(v)
    if (m && m !== month) setList({ month: m, page: 1 })
  }

  function toggle(id: string, email: string) {
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(id)) next.delete(id)
      else if (next.size < BULK_MAX) next.set(id, email)
      return next
    })
  }

  function askBulk(b: Bulk) {
    if (!bulkBusy) setBulk(b)
  }

  function runBulk() {
    if (!bulk || bulkBusy) return
    const chosen = [...selected.keys()]
    setBulk(null)
    bulkMutation
      .mutateAsync({ ids: chosen, ...bulk })
      .then((res) => {
        const s = bulkSummary(res)
        setSelected(new Map())
        // the bulk bar (and the button that opened the dialog) is gone: keep focus on the list
        focusList()
        setNotice(s.failed > 0 ? 'admin.users.bulk.partial' : 'admin.users.bulk.done', s.failed > 0 ? 'warning' : 'success', s)
      })
      .catch((err: unknown) => setNotice(adminErrorKey(err), 'error'))
  }

  const usage = (u: AdminUserRow) => {
    const a = quotaParts(u.audio_seconds)
    return t('admin.users.usageValue', { tokens: f.number(u.gemini_tokens), h: a.hours, m: a.minutes })
  }
  const from = total === 0 ? 0 : (page - 1) * PER_PAGE + 1
  const to = Math.min(total, page * PER_PAGE)

  return (
    <>
      <AdminHead titleKey="admin.tabs.users" subtitleKey="admin.users.subtitle" />
      <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} />
      <div className="admin-toolbar">
        <form className="search" role="search" onSubmit={submitSearch}>
          <Search size={17} aria-hidden="true" />
          <label htmlFor={ids.search} className="sr-only">
            {t('admin.users.search')}
          </label>
          <input id={ids.search} type="search" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('admin.users.searchPlaceholder')} maxLength={200} />
          <button type="submit" className="sr-only" tabIndex={-1}>
            {t('admin.users.searchSubmit')}
          </button>
        </form>
        <label htmlFor={ids.month} className="toolbar-label">
          {t('admin.users.month')}
        </label>
        <input
          id={ids.month}
          type="month"
          value={monthDraft}
          min="1970-01"
          max="2100-12"
          // a browser without a month picker shows a text box: apply only a complete value
          onChange={(e) => {
            setMonthDraft(e.target.value)
            applyMonth(e.target.value)
          }}
          onBlur={() => setMonthDraft(month)}
          onKeyDown={(e) => e.key === 'Enter' && applyMonth(monthDraft)}
        />
      </div>

      <p className="sr-only" role="status">
        {selected.size > 0 ? t('admin.users.bulk.selected', { count: selected.size }) : ''}
      </p>
      {selected.size > 0 && (
        <div className="bulk-bar" role="group" aria-label={t('admin.users.bulk.label')}>
          <span>{t('admin.users.bulk.selected', { count: selected.size })}</span>
          <Button onClick={() => askBulk({ action: 'disable' })} aria-disabled={bulkBusy}>{t('admin.users.actions.disable')}</Button>
          <Button onClick={() => askBulk({ action: 'enable' })} aria-disabled={bulkBusy}>{t('admin.users.actions.enable')}</Button>
          <Button onClick={() => askBulk({ action: 'set_role', role: 'admin' })} aria-disabled={bulkBusy}>{t('admin.users.actions.makeAdmin')}</Button>
          <Button onClick={() => askBulk({ action: 'set_role', role: 'user' })} aria-disabled={bulkBusy}>{t('admin.users.actions.makeUser')}</Button>
          <Button
            variant="ghost"
            onClick={() => {
              if (bulkBusy) return
              setSelected(new Map())
              focusList()
            }}
            aria-disabled={bulkBusy}
          >
            {t('admin.users.bulk.clear')}
          </Button>
        </div>
      )}

      {list.isPending ? (
        <p className="tab-note">{t('common.loading')}</p>
      ) : list.isError && !list.data ? (
        <div className="tab-note">
          <p>{t(adminErrorKey(list.error))}</p>
          <Button onClick={() => void list.refetch()}>{t('common.tryAgain')}</Button>
        </div>
      ) : users.length === 0 ? (
        <p className="tab-note">{t(search ? 'admin.users.noMatch' : 'admin.users.empty')}</p>
      ) : (
        <div className="table-scroll" tabIndex={0} role="region" aria-labelledby={ids.caption}>
          <table className="admin-table">
            <caption className="sr-only" id={ids.caption}>{t('admin.users.caption', { month: list.data?.month ?? month })}</caption>
            <thead>
              <tr>
                <th scope="col">
                  <input
                    id={ids.all}
                    ref={allRef}
                    type="checkbox"
                    checked={allChecked}
                    aria-label={t('admin.users.selectAll')}
                    onChange={() => setSelected(allChecked ? new Map() : new Map(selectable.slice(0, BULK_MAX).map((u) => [u.id, u.email])))}
                  />
                </th>
                <th scope="col">{t('admin.users.col.user')}</th>
                <th scope="col">{t('admin.users.col.role')}</th>
                <th scope="col">{t('admin.users.col.status')}</th>
                <th scope="col">{t('admin.users.col.meetings')}</th>
                <th scope="col">{t('admin.users.col.usage')}</th>
                <th scope="col">{t('admin.users.col.lastSignIn')}</th>
                <th scope="col">{t('admin.users.col.created')}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const self = u.id === me
                const name = displayText(u.email)
                return (
                  <tr key={u.id}>
                    <td>
                      {!self && (
                        <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggle(u.id, u.email)} aria-label={t('admin.users.select', { name })} />
                      )}
                    </td>
                    <th scope="row">
                      <div className="user-cell">
                        <div>
                          <Link to={`/admin/users/${encodeURIComponent(u.id)}`} className="user-link">
                            {name}
                          </Link>
                          {u.username && <small>{t('admin.users.handle', { name: displayText(u.username) })}</small>}
                        </div>
                        {self && <span className="you-badge">{t('admin.users.you')}</span>}
                      </div>
                    </th>
                    <td>
                      <span className="role-badge">{t(`admin.users.role.${u.role}`)}</span>
                    </td>
                    <td>
                      <UserStatusBadge status={u.status} />
                    </td>
                    <td className="num">{f.number(u.meeting_count)}</td>
                    <td>{usage(u)}</td>
                    <td>{f.dateTime(u.last_sign_in_at) ?? t('admin.users.never')}</td>
                    <td>{f.date(u.created_at)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <nav className="pagination" aria-label={t('admin.pagination.label')}>
        <span aria-live="polite">{t('admin.pagination.range', { from, to, total })}</span>
        <Button onClick={() => page > 1 && setList({ page: page - 1 })} aria-disabled={page <= 1}>
          {t('admin.pagination.previous')}
        </Button>
        <Button onClick={() => to < total && setList({ page: page + 1 })} aria-disabled={to >= total}>
          {t('admin.pagination.next')}
        </Button>
      </nav>

      {bulk && (
        <Modal title={t('admin.users.bulk.confirmTitle', { count: selected.size })} onClose={() => setBulk(null)} describedBy={ids.bulkBody}>
          <p className="modal-copy" id={ids.bulkBody}>
            {t(`admin.users.bulk.confirm.${bulk.action === 'set_role' ? `role_${bulk.role}` : bulk.action}`, { count: selected.size })}
          </p>
          <ul className="bulk-names">
            {[...selected.values()].map((email) => (
              <li key={email} className="bidi-isolate">
                {displayText(email)}
              </li>
            ))}
          </ul>
          <div className="modal-actions">
            <Button variant="ghost" onClick={() => setBulk(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant={bulk.action === 'disable' ? 'danger' : 'primary'} onClick={runBulk}>
              {t('admin.users.bulk.apply')}
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
}
