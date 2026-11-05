// Admin › Users (ARC-14a, Make UsersAdmin): search, usage month, bulk disable / enable / role.
import { useEffect, useId, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAdminUsers, useUserMutations, type AdminUserRow } from '../../api/admin/users'
import { useAuth } from '../../auth/AuthProvider'
import { AdminHead, NoticeBanner, UserStatusBadge, useFormatters, useNotice } from '../../components/admin/AdminParts'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import { adminErrorKey, bulkSummary, monthValue } from '../../lib/admin/users'
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
  const [draft, setDraft] = useState('')
  const [search, setSearch] = useState('')
  const [month, setMonth] = useState(() => monthValue(new Date()) ?? '')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulk, setBulk] = useState<Bulk | null>(null)
  const [notice, setNotice] = useNotice()
  // a user deleted from the detail page reports here (router state, cleared so a reload is quiet)
  const location = useLocation()
  const navigate = useNavigate()
  const arrived = (location.state as { notice?: unknown } | null)?.notice
  useEffect(() => {
    if (arrived !== 'deleted' && arrived !== 'deletedWarning') return
    setNotice(arrived === 'deleted' ? 'admin.users.deleted' : 'admin.users.deletedWarning', arrived === 'deleted' ? 'success' : 'warning')
    void navigate('.', { replace: true, state: null })
  }, [arrived, navigate]) // eslint-disable-line react-hooks/exhaustive-deps
  const list = useAdminUsers({ page, perPage: PER_PAGE, search, month })
  const { bulk: bulkMutation } = useUserMutations()
  const f = useFormatters()
  const ids = { search: useId(), month: useId(), all: useId() }

  const users = list.data?.users ?? []
  const total = list.data?.total ?? 0
  const selectable = users.filter((u) => u.id !== me)
  const allChecked = selectable.length > 0 && selectable.every((u) => selected.has(u.id))

  function submitSearch(e: FormEvent) {
    e.preventDefault()
    setSearch(draft.trim())
    setPage(1)
    setSelected(new Set())
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function runBulk() {
    if (!bulk || bulkMutation.isPending) return
    const chosen = [...selected]
    setBulk(null)
    bulkMutation
      .mutateAsync({ ids: chosen, ...bulk })
      .then((res) => {
        const s = bulkSummary(res)
        setSelected(new Set())
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
        </form>
        <label htmlFor={ids.month} className="toolbar-label">
          {t('admin.users.month')}
        </label>
        <input
          id={ids.month}
          type="month"
          value={month}
          onChange={(e) => {
            const v = monthValue(e.target.value)
            if (v) {
              setMonth(v)
              setPage(1)
            }
          }}
        />
      </div>

      {selected.size > 0 && (
        <div className="bulk-bar" role="group" aria-label={t('admin.users.bulk.label')}>
          <span>{t('admin.users.bulk.selected', { count: selected.size })}</span>
          <Button onClick={() => setBulk({ action: 'disable' })}>{t('admin.users.actions.disable')}</Button>
          <Button onClick={() => setBulk({ action: 'enable' })}>{t('admin.users.actions.enable')}</Button>
          <Button onClick={() => setBulk({ action: 'set_role', role: 'admin' })}>{t('admin.users.actions.makeAdmin')}</Button>
          <Button onClick={() => setBulk({ action: 'set_role', role: 'user' })}>{t('admin.users.actions.makeUser')}</Button>
          <Button variant="ghost" onClick={() => setSelected(new Set())}>
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
        <div className="table-scroll">
          <table className="admin-table">
            <caption className="sr-only">{t('admin.users.caption', { month })}</caption>
            <thead>
              <tr>
                <th scope="col">
                  <input
                    id={ids.all}
                    type="checkbox"
                    checked={allChecked}
                    aria-label={t('admin.users.selectAll')}
                    onChange={() => setSelected(allChecked ? new Set() : new Set(selectable.map((u) => u.id)))}
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
                        <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggle(u.id)} aria-label={t('admin.users.select', { name })} />
                      )}
                    </td>
                    <td>
                      <div className="user-cell">
                        <div>
                          <Link to={`/admin/users/${encodeURIComponent(u.id)}`} className="user-link">
                            {name}
                          </Link>
                          {u.username && <small>{t('admin.users.handle', { name: displayText(u.username) })}</small>}
                        </div>
                        {self && <span className="you-badge">{t('admin.users.you')}</span>}
                      </div>
                    </td>
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
        <span>{t('admin.pagination.range', { from, to, total })}</span>
        <Button onClick={() => page > 1 && setPage((p) => p - 1)} aria-disabled={page <= 1}>
          {t('admin.pagination.previous')}
        </Button>
        <Button onClick={() => to < total && setPage((p) => p + 1)} aria-disabled={to >= total}>
          {t('admin.pagination.next')}
        </Button>
      </nav>

      {bulk && (
        <Modal title={t('admin.users.bulk.confirmTitle', { count: selected.size })} onClose={() => setBulk(null)} describedBy="bulk-body">
          <p className="modal-copy" id="bulk-body">
            {t(`admin.users.bulk.confirm.${bulk.action === 'set_role' ? `role_${bulk.role}` : bulk.action}`, { count: selected.size })}
          </p>
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
