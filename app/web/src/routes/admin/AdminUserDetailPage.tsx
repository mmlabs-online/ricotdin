// Admin › User detail (ARC-14a): role, disable / enable, password reset mail, delete, quota grant
// and history, recent activity. Every action asks first; the API enforces every guard (§0.9).
import { useId, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAdminUser, useUserActivity, useUserMutations, useUserQuota } from '../../api/admin/users'
import { useAuth } from '../../auth/AuthProvider'
import { AdminHead, NoticeBanner, UserStatusBadge, useFormatters, useNotice } from '../../components/admin/AdminParts'
import { FullPageLoading } from '../../components/FullPageLoading'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import { ApiError } from '../../api/errors'
import { adminErrorKey, grantAmount, grantProblem, ledgerReasonKey, userActions } from '../../lib/admin/users'
import { quotaParts } from '../../lib/profile/profile'
import { displayText } from '../../lib/text'
import { useDocumentTitle } from '../../lib/useDocumentTitle'

type Confirm = 'promote' | 'demote' | 'disable' | 'enable' | 'reset' | 'delete'

export function AdminUserDetailPage() {
  const { t } = useTranslation()
  useDocumentTitle('admin.userDetail.title')
  const { userId = '' } = useParams()
  const user = useAdminUser(userId)
  if (user.isPending) return <FullPageLoading />
  if (!user.data) {
    const missing = user.error instanceof ApiError && (user.error.status === 404 || user.error.status === 400)
    return (
      <>
        <BackLink />
        <div className="empty-state">
          <h1>{t(missing ? 'admin.userDetail.notFound' : adminErrorKey(user.error))}</h1>
          {!missing && <Button onClick={() => void user.refetch()}>{t('common.tryAgain')}</Button>}
        </div>
      </>
    )
  }
  return <UserDetail user={user.data} />
}

function BackLink() {
  const { t } = useTranslation()
  return (
    <Link className="button button-ghost back-button" to="/admin/users">
      <ArrowLeft size={16} aria-hidden="true" /> {t('admin.userDetail.back')}
    </Link>
  )
}

function UserDetail({ user }: { user: NonNullable<ReturnType<typeof useAdminUser>['data']> }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { state } = useAuth()
  const me = state.status === 'signedIn' ? state.user.id : ''
  const m = useUserMutations()
  const f = useFormatters()
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const ids = { promoteHint: useId(), confirmBody: useId() }
  const [notice, setNotice] = useNotice()
  const actions = userActions(user, me)
  const name = displayText(user.email)
  const busy = m.role.isPending || m.status.isPending || m.reset.isPending || m.remove.isPending
  const fail = (err: unknown) => setNotice(adminErrorKey(err), 'error')
  const ask = (what: Confirm) => {
    if (busy || (what === 'promote' && !actions.promote)) return
    setConfirm(what)
  }

  function run(what: Confirm) {
    setConfirm(null)
    if (busy) return
    const id = user.id
    if (what === 'promote' || what === 'demote') {
      m.role.mutateAsync({ id, role: what === 'promote' ? 'admin' : 'user' }).then(() => setNotice(`admin.userDetail.done.${what}`)).catch(fail)
    } else if (what === 'disable' || what === 'enable') {
      m.status.mutateAsync({ id, disabled: what === 'disable' }).then(() => setNotice(`admin.userDetail.done.${what}`)).catch(fail)
    } else if (what === 'reset') {
      m.reset
        .mutateAsync(id)
        .then((r) => setNotice(r.email_sent === false ? 'admin.userDetail.done.resetNoMail' : 'admin.userDetail.done.reset', r.email_sent === false ? 'warning' : 'success'))
        .catch(fail)
    } else {
      m.remove
        .mutateAsync(id)
        .then((r) => void navigate('/admin/users', { state: { notice: r.storageWarnings?.length ? 'deletedWarning' : 'deleted' } }))
        .catch(fail)
    }
  }

  return (
    <>
      <BackLink />
      <AdminHead titleKey="admin.userDetail.title" />
      <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} />

      <section className="admin-card" aria-labelledby="user-head">
        <div className="card-head">
          <h2 id="user-head" className="bidi-isolate">
            {name}{' '}
            {user.id === me && <span className="you-badge">{t('admin.users.you')}</span>}
          </h2>
          <UserStatusBadge status={user.status} />
        </div>
        <dl className="fact-list">
          <div>
            <dt>{t('admin.users.col.username')}</dt>
            <dd>{user.username ? t('admin.users.handle', { name: displayText(user.username) }) : '—'}</dd>
          </div>
          <div>
            <dt>{t('admin.users.col.role')}</dt>
            <dd>{t(`admin.users.role.${user.role}`)}</dd>
          </div>
          <div>
            <dt>{t('admin.users.col.meetings')}</dt>
            <dd>{f.number(user.meeting_count)}</dd>
          </div>
          <div>
            <dt>{t('admin.users.col.created')}</dt>
            <dd>{f.dateTime(user.created_at)}</dd>
          </div>
          <div>
            <dt>{t('admin.users.col.lastSignIn')}</dt>
            <dd>{f.dateTime(user.last_sign_in_at) ?? t('admin.users.never')}</dd>
          </div>
        </dl>
        <div className="action-row" role="group" aria-label={t('admin.userDetail.actions')}>
          {/* one button per pair whose label flips, so focus stays on it after the change */}
          {actions.changeRole && (
            <Button onClick={() => ask(user.role === 'user' ? 'promote' : 'demote')} aria-disabled={(user.role === 'user' && !actions.promote) || busy}
              aria-describedby={user.role === 'user' && !actions.promote ? ids.promoteHint : undefined}
            >
              {t(user.role === 'user' ? 'admin.users.actions.makeAdmin' : 'admin.users.actions.makeUser')}
            </Button>
          )}
          {(actions.disable || actions.enable) && (
            <Button onClick={() => ask(actions.disable ? 'disable' : 'enable')} aria-disabled={busy}>
              {t(actions.disable ? 'admin.users.actions.disable' : 'admin.users.actions.enable')}
            </Button>
          )}
          <Button onClick={() => ask('reset')} aria-disabled={busy}>
            {t('admin.users.actions.reset')}
          </Button>
          {actions.delete && (
            <Button variant="danger" onClick={() => ask('delete')} aria-disabled={busy}>
              {t('admin.users.actions.delete')}
            </Button>
          )}
        </div>
        {user.role === 'user' && actions.changeRole && !actions.promote && (
          <p className="tab-note" id={ids.promoteHint}>
            {t('admin.userDetail.promoteHint')}
          </p>
        )}
        {user.id === me && <p className="tab-note">{t('admin.userDetail.selfHint')}</p>}
      </section>

      <QuotaCard userId={user.id} name={name} onNotice={setNotice} />
      <ActivityCard userId={user.id} />

      {confirm && (
        <Modal
          title={t(`admin.userDetail.confirm.${confirm}.title`)}
          onClose={() => setConfirm(null)}
          describedBy={ids.confirmBody}
        >
          <p className="modal-copy" id={ids.confirmBody}>
            {t(`admin.userDetail.confirm.${confirm}.body`, { name })}
          </p>
          <div className="modal-actions">
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant={confirm === 'delete' || confirm === 'disable' ? 'danger' : 'primary'} onClick={() => run(confirm)}>
              {t(`admin.userDetail.confirm.${confirm}.action`)}
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
}

type Grant = { audio_minutes?: number; agent_queries?: number; note?: string }

function QuotaCard({ userId, name, onNotice }: { userId: string; name: string; onNotice: (key: string | null, kind?: 'success' | 'warning' | 'error') => void }) {
  const { t } = useTranslation()
  const quota = useUserQuota(userId)
  const { grant } = useUserMutations()
  const f = useFormatters()
  const [minutes, setMinutes] = useState('')
  const [queries, setQueries] = useState('')
  const [note, setNote] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [pending, setPending] = useState<Grant | null>(null) // asked, not sent yet
  const [tries, setTries] = useState(0) // keys the error / result node, so a repeat is announced
  const [done, setDone] = useState(false)
  const minutesRef = useRef<HTMLInputElement>(null)
  const queriesRef = useRef<HTMLInputElement>(null)
  // which field is at fault: each checked alone (an empty pair is the minutes field's problem)
  const fieldBad = (p: string | null) => p !== null && p !== 'admin.quota.errors.empty'
  const minutesBad = problem !== null && (fieldBad(grantProblem(minutes, '')) || problem === 'admin.quota.errors.empty')
  const queriesBad = problem !== null && fieldBad(grantProblem('', queries))
  const ids = { minutes: useId(), queries: useId(), note: useId(), err: useId(), history: useId(), grantBody: useId() }

  function submit(e: FormEvent) {
    e.preventDefault()
    if (grant.isPending) return
    const p = grantProblem(minutes, queries)
    setProblem(p)
    setDone(false)
    setTries((n) => n + 1)
    if (p) {
      const minutesWrong = p === 'admin.quota.errors.empty' || fieldBad(grantProblem(minutes, ''))
      ;(minutesWrong ? minutesRef : queriesRef).current?.focus()
      return
    }
    const m = grantAmount(minutes)
    const q = grantAmount(queries)
    // a grant cannot be undone from here and costs provider spend: ask first
    setPending({ ...(m ? { audio_minutes: m } : {}), ...(q ? { agent_queries: q } : {}), ...(note.trim() ? { note: note.trim() } : {}) })
  }

  function send() {
    if (!pending || grant.isPending) return
    const body = pending
    setPending(null)
    grant
      .mutateAsync({ id: userId, ...body })
      .then(() => {
        setMinutes('')
        setQueries('')
        setNote('')
        setDone(true)
        setTries((n) => n + 1)
        onNotice('admin.quota.granted')
      })
      .catch((err: unknown) => onNotice(adminErrorKey(err), 'error'))
  }

  const wallet = quota.data?.wallet
  const audio = quotaParts(wallet?.audio_seconds_remaining ?? 0)
  return (
    <section className="admin-card" aria-labelledby="quota-head">
      <div className="card-head">
        <h2 id="quota-head">{t('admin.quota.title')}</h2>
      </div>
      {quota.isPending ? (
        <p className="tab-note">{t('common.loading')}</p>
      ) : !quota.data ? (
        <p className="tab-note">{t(adminErrorKey(quota.error))}</p>
      ) : (
        <>
          <dl className="usage-list">
            <div>
              <dt>{t('profile.usage.audio')}</dt>
              <dd>{t('profile.usage.audioValue', { h: audio.hours, m: audio.minutes })}</dd>
            </div>
            <div>
              <dt>{t('profile.usage.questions')}</dt>
              <dd>{t('profile.usage.questionsValue', { count: Math.max(0, wallet?.agent_queries_remaining ?? 0) })}</dd>
            </div>
          </dl>
          <form className="grant-form" onSubmit={submit} noValidate>
            <h3 className="subhead">{t('admin.quota.grantTitle')}</h3>
            <div className="field-row">
              <label htmlFor={ids.minutes}>{t('admin.quota.minutes')}</label>
              <input id={ids.minutes} ref={minutesRef} inputMode="decimal" value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-invalid={minutesBad} aria-describedby={minutesBad ? ids.err : undefined} />
            </div>
            <div className="field-row">
              <label htmlFor={ids.queries}>{t('admin.quota.queries')}</label>
              <input id={ids.queries} ref={queriesRef} inputMode="numeric" value={queries} onChange={(e) => setQueries(e.target.value)} aria-invalid={queriesBad} aria-describedby={queriesBad ? ids.err : undefined} />
            </div>
            <div className="field-row">
              <label htmlFor={ids.note}>{t('admin.quota.note')}</label>
              <input id={ids.note} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            </div>
            {/* the result also next to the form (the page banner is off-screen when zoomed in) */}
            <div id={ids.err}>
              {problem && (
                <p key={tries} className="form-note error" role="alert">
                  {t(problem)}
                </p>
              )}
              {done && (
                <p key={tries} className="form-note">
                  {t('admin.quota.granted')}
                </p>
              )}
            </div>
            <Button type="submit" variant="primary" aria-disabled={grant.isPending} aria-busy={grant.isPending}>
              {t('admin.quota.grant')}
            </Button>
          </form>
          {pending && (
            <Modal title={t('admin.quota.confirmTitle')} onClose={() => setPending(null)} describedBy={ids.grantBody}>
              <p className="modal-copy" id={ids.grantBody}>
                {t('admin.quota.confirmBody', { name, minutes: f.number(pending.audio_minutes ?? 0), queries: f.number(pending.agent_queries ?? 0) })}
              </p>
              <div className="modal-actions">
                <Button variant="ghost" onClick={() => setPending(null)}>
                  {t('common.cancel')}
                </Button>
                <Button variant="primary" onClick={send}>
                  {t('admin.quota.grant')}
                </Button>
              </div>
            </Modal>
          )}
          <h3 className="subhead" id={ids.history}>
            {t('admin.quota.history')}
          </h3>
          {quota.data.ledger.length === 0 ? (
            <p className="tab-note">{t('admin.quota.noHistory')}</p>
          ) : (
            <div className="table-scroll" tabIndex={0} role="region" aria-labelledby={ids.history}>
              <table className="admin-table">
                <thead>
                  <tr>
                    <th scope="col">{t('admin.quota.col.when')}</th>
                    <th scope="col">{t('admin.quota.col.reason')}</th>
                    <th scope="col">{t('admin.quota.col.audio')}</th>
                    <th scope="col">{t('admin.quota.col.queries')}</th>
                  </tr>
                </thead>
                <tbody>
                  {quota.data.ledger.map((r) => (
                    <tr key={r.id}>
                      <td>{f.dateTime(r.created_at)}</td>
                      <td>{t(ledgerReasonKey(r.reason))}</td>
                      <td className="num">{t('admin.quota.minutesDelta', { value: f.number(Math.round(r.delta_audio_seconds / 6) / 10) })}</td>
                      <td className="num">{f.number(r.delta_agent_queries)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function ActivityCard({ userId }: { userId: string }) {
  const { t } = useTranslation()
  const activity = useUserActivity(userId)
  const f = useFormatters()
  return (
    <section className="admin-card" aria-labelledby="activity-head">
      <div className="card-head">
        <h2 id="activity-head">{t('admin.userDetail.activity')}</h2>
      </div>
      {activity.isPending ? (
        <p className="tab-note">{t('common.loading')}</p>
      ) : !activity.data ? (
        <p className="tab-note">{t(adminErrorKey(activity.error))}</p>
      ) : activity.data.length === 0 ? (
        <p className="tab-note">{t('admin.userDetail.noActivity')}</p>
      ) : (
        <ul className="timeline">
          {activity.data.map((a) => (
            <li className="event" key={a.id}>
              <span className="event-badge">{displayText(a.event_type)}</span>
              <strong className="bidi-isolate">{a.meeting_title ? displayText(a.meeting_title) : '—'}</strong>
              <small>{f.dateTime(a.created_at)}</small>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
