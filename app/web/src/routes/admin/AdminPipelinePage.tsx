// Admin › Pipeline (ARC-14b, Make PipelineAdmin): status counts, jobs by status, requeue of failed
// or stuck meetings (each asks first: a new run charges the owner's quota, §0.7), worker tasks.
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { usePipelineJobs, usePipelineOverview, useRefreshPipeline, useRequeue, useSchedulers, type JobRow } from '../../api/admin/ops'
import { AdminHead, AdminPagination, NoticeBanner, useClampPage, useFormatters, useNotice, useUrlState } from '../../components/admin/AdminParts'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import { Status } from '../../components/ui/Status'
import { canRequeue, durationParts, PIPELINE_FILTERS, pipelineFilter, type PipelineFilter } from '../../lib/admin/ops'
import { adminErrorKey } from '../../lib/admin/users'
import { displayText } from '../../lib/text'
import { useDocumentTitle } from '../../lib/useDocumentTitle'

const PER_PAGE = 20
type Kind = 'success' | 'danger' | 'processing'

function statusOf(j: JobRow): { kind: Kind; key: string } {
  if (j.status === 'processing' && j.is_stuck) return { kind: 'danger', key: 'stuck' }
  if (j.status === 'done') return { kind: 'success', key: 'done' }
  if (j.status === 'failed') return { kind: 'danger', key: 'failed' }
  return { kind: 'processing', key: j.status === 'pending' ? 'pending' : 'processing' }
}

export function AdminPipelinePage() {
  const { t } = useTranslation()
  useDocumentTitle('admin.tabs.pipeline')
  const url = useUrlState()
  const filter = pipelineFilter(url.get('status'))
  const page = url.page
  const overview = usePipelineOverview()
  const jobs = usePipelineJobs({ status: filter, page, perPage: PER_PAGE })
  const requeue = useRequeue()
  const refresh = useRefreshPipeline()
  const [running, setRunning] = useState(false) // a requeue batch is going (one request at a time)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false // leaving the page stops the batch: each requeue charges an owner
    }
  }, [])
  const [ask, setAsk] = useState<JobRow[] | null>(null) // meetings to requeue, asked not sent
  const [notice, setNotice] = useNotice()
  const f = useFormatters()
  const ids = { caption: useId(), body: useId() }

  const rows = jobs.data?.jobs ?? []
  const eligible = rows.filter(canRequeue)
  const counts = overview.data?.counts
  const setFilter = (s: PipelineFilter) => url.set({ status: s === 'all' ? null : s, page: 1 })
  useClampPage(jobs.data?.total, PER_PAGE, page, rows.length, (p) => url.set({ page: p }))

  async function run() {
    if (!ask || running) return
    const list = ask
    setAsk(null)
    setRunning(true)
    let ok = 0
    const failed: string[] = []
    let lastError: unknown = null
    // one at a time: each is its own audited change, and the API refuses concurrent ones (409)
    for (const j of list) {
      if (!alive.current) return
      try {
        await requeue.mutateAsync(j.id)
        ok += 1
      } catch (err) {
        failed.push(displayText(j.title))
        lastError = err
      }
    }
    await refresh()
    if (!alive.current) return
    setRunning(false)
    if (list.length === 1 && failed.length === 1) setNotice(adminErrorKey(lastError), 'error')
    else
      setNotice(failed.length ? 'admin.pipeline.requeuePartial' : 'admin.pipeline.requeued', failed.length ? 'warning' : 'success', {
        count: ok,
        failed: failed.length,
        titles: failed.join(', '),
      })
  }

  const duration = (s: number | null) => {
    const d = durationParts(s)
    return d ? t('admin.pipeline.duration', { h: d.h, m: String(d.m).padStart(2, '0'), s: String(d.s).padStart(2, '0') }) : '—'
  }

  const averageTime = (sec: number | null) => {
    const d = durationParts(sec)
    if (!d) return '—'
    return d.h > 0 ? t('admin.pipeline.hoursMinutes', { h: f.number(d.h), m: d.m }) : t('admin.pipeline.minutesSeconds', { m: d.m, s: d.s })
  }

  return (
    <>
      <AdminHead titleKey="admin.tabs.pipeline" subtitleKey="admin.pipeline.subtitle" />
      <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} />
      <p className="refresh-line">
        <span>
          <span className="live-dot" aria-hidden="true" /> {t('admin.pipeline.autoRefresh')}
        </span>
        {jobs.dataUpdatedAt > 0 && <span>{t('admin.pipeline.updated', { time: f.time(jobs.dataUpdatedAt) })}</span>}
      </p>

      <div className="pipeline-stats" role="group" aria-label={t('admin.pipeline.countsLabel')}>
        {(['pending', 'processing', 'stuck', 'failed', 'done'] as const).map((s) => (
          <button key={s} type="button" aria-pressed={filter === s} className={filter === s ? 'active' : ''} onClick={() => setFilter(s)}>
            <span>{t(`admin.pipeline.status.${s}`)}</span>
            <strong>{counts ? f.number(counts[s]) : '—'}</strong>
          </button>
        ))}
        <div className="stat-static">
          <span>{t('admin.pipeline.avgTime')}</span>
          <strong>{overview.data ? averageTime(overview.data.avg_processing_secs) : '—'}</strong>
        </div>
      </div>
      {overview.isError && (
        <p className="tab-note">
          {t(adminErrorKey(overview.error))} <Button onClick={() => void overview.refetch()}>{t('common.tryAgain')}</Button>
        </p>
      )}

      <div className="admin-toolbar">
        <div className="filter-tabs" role="group" aria-label={t('admin.pipeline.filterLabel')}>
          {PIPELINE_FILTERS.map((s) => (
            <button key={s} type="button" aria-pressed={filter === s} className={filter === s ? 'active' : ''} onClick={() => setFilter(s)}>
              {t(s === 'all' ? 'admin.pipeline.all' : `admin.pipeline.status.${s}`)}
            </button>
          ))}
        </div>
        <Button variant="danger" onClick={() => eligible.length && !running && setAsk(eligible)} aria-disabled={eligible.length === 0 || running} aria-busy={running}>
          {t('admin.pipeline.requeueAll', { count: eligible.length })}
        </Button>
      </div>

      {jobs.isPending ? (
        <p className="tab-note">{t('common.loading')}</p>
      ) : jobs.isError && !jobs.data ? (
        <div className="tab-note">
          <p>{t(adminErrorKey(jobs.error))}</p>
          <Button onClick={() => void jobs.refetch()}>{t('common.tryAgain')}</Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="tab-note">{t('admin.pipeline.empty')}</p>
      ) : (
        <div className="table-scroll" tabIndex={0} role="region" aria-labelledby={ids.caption}>
          <table className="admin-table">
            <caption className="sr-only" id={ids.caption}>
              {t('admin.pipeline.caption')}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('admin.pipeline.col.status')}</th>
                <th scope="col">{t('admin.pipeline.col.meeting')}</th>
                <th scope="col">{t('admin.pipeline.col.owner')}</th>
                <th scope="col">{t('admin.pipeline.col.created')}</th>
                <th scope="col">{t('admin.pipeline.col.duration')}</th>
                <th scope="col">{t('admin.pipeline.col.job')}</th>
                <th scope="col">{t('admin.pipeline.col.error')}</th>
                <th scope="col">
                  <span className="sr-only">{t('admin.pipeline.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((j) => {
                const st = statusOf(j)
                const error = j.job?.last_error ?? j.error_message
                return (
                  <tr key={j.id}>
                    <td>
                      <Status type={st.kind}>{t(`admin.pipeline.status.${st.key}`)}</Status>
                    </td>
                    <th scope="row" className="bidi-isolate wrap">
                      {displayText(j.title)}
                    </th>
                    <td className="bidi-isolate">{j.owner_email ? displayText(j.owner_email) : '—'}</td>
                    <td>{f.dateTime(j.created_at)}</td>
                    <td className="num">{duration(j.duration_seconds)}</td>
                    <td>{j.job ? t('admin.pipeline.jobState', { status: t(`admin.pipeline.jobStatus.${jobStatusKey(j.job.status)}`), step: displayText(j.job.step ?? '—'), attempts: j.job.attempts }) : '—'}</td>
                    <td className="error-cell">{error ? displayText(error) : '—'}</td>
                    <td>
                      {canRequeue(j) && (
                        <Button onClick={() => !running && setAsk([j])} aria-disabled={running} aria-label={t('admin.pipeline.requeueOne', { title: displayText(j.title) })}>
                          {t('admin.pipeline.requeue')}
                        </Button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {jobs.data && <AdminPagination page={page} perPage={PER_PAGE} total={jobs.data.total} onPage={(p) => url.set({ page: p })} />}

      <SchedulerCard />

      {ask && (
        <Modal title={t('admin.pipeline.confirmTitle', { count: ask.length })} onClose={() => setAsk(null)} describedBy={ids.body}>
          <p className="modal-copy" id={ids.body}>
            {t('admin.pipeline.confirmBody', { count: ask.length })}
          </p>
          <ul className="bulk-names">
            {ask.map((j) => (
              <li key={j.id} className="bidi-isolate">
                {displayText(j.title)}
              </li>
            ))}
          </ul>
          <div className="modal-actions">
            <Button variant="ghost" onClick={() => setAsk(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void run()}>
              {t('admin.pipeline.requeue')}
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
}

const JOB_STATUSES = new Set(['queued', 'running', 'done', 'failed'])
const jobStatusKey = (s: string) => (JOB_STATUSES.has(s) ? s : 'other')

function SchedulerCard() {
  const { t } = useTranslation()
  const tasks = useSchedulers()
  const f = useFormatters()
  const ids = { head: useId() }
  return (
    <section className="admin-card" aria-labelledby={ids.head}>
      <div className="card-head">
        <h2 id={ids.head}>{t('admin.pipeline.tasks.title')}</h2>
      </div>
      {tasks.isPending ? (
        <p className="tab-note">{t('common.loading')}</p>
      ) : !tasks.data ? (
        <p className="tab-note">{t(adminErrorKey(tasks.error))}</p>
      ) : tasks.data.length === 0 ? (
        <p className="tab-note">{t('admin.pipeline.tasks.none')}</p>
      ) : (
        <ul className="health-list">
          {tasks.data.map((task) => {
            const bad = task.stale || task.last_status === 'error'
            return (
              <li key={task.task}>
                <span className="task-name">
                  <strong>{t(`admin.pipeline.tasks.name.${TASKS.has(task.task) ? task.task : 'other'}`, { name: displayText(task.task) })}</strong>
                  <small>
                    {task.last_finished_at ? t('admin.pipeline.tasks.last', { time: f.dateTime(task.last_finished_at) }) : t('admin.pipeline.tasks.never')}
                    {task.last_status === 'error' && task.last_detail ? ` · ${displayText(task.last_detail)}` : ''}
                  </small>
                </span>
                <Status type={bad ? 'danger' : task.last_status === 'ok' ? 'success' : 'processing'}>
                  {t(task.stale ? 'admin.pipeline.tasks.stale' : task.last_status === 'error' ? 'admin.health.status.error' : task.last_status === 'ok' ? 'admin.health.status.ok' : 'admin.health.status.unknown')}
                </Status>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

const TASKS = new Set(['key_health', 'retention_purge', 'wallet_reconcile', 'stuck_meetings'])
