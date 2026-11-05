// Admin › Health (ARC-14c) and Storage: the API's checks (database, Drive, key encryption, provider
// keys from the last check, worker tasks; 503 when degraded) and the Drive connection + stored files.
import { useTranslation } from 'react-i18next'
import { useHealthReport, useStorageStatus } from '../../api/admin/config'
import { AdminHead, useFormatters } from '../../components/admin/AdminParts'
import { Button } from '../../components/ui/Button'
import { Status } from '../../components/ui/Status'
import { adminErrorKey, healthSummary } from '../../lib/admin/users'
import { displayText } from '../../lib/text'
import { useDocumentTitle } from '../../lib/useDocumentTitle'

const KNOWN_PROBLEMS = new Set(['not_configured', 'error', 'token_refresh_failed', 'root_missing', 'shared_root'])

export function AdminHealthPage() {
  const { t } = useTranslation()
  useDocumentTitle('admin.tabs.health')
  const report = useHealthReport()
  const f = useFormatters()
  const health = healthSummary(report.data)
  const raw = (report.data ?? {}) as { checks?: Record<string, { message?: unknown }> }
  const message = (id: string) => {
    const m = raw.checks?.[id]?.message
    return typeof m === 'string' ? displayText(m.slice(0, 200)) : null
  }
  const ids = Object.keys(raw.checks ?? {})

  return (
    <>
      <AdminHead titleKey="admin.tabs.health" subtitleKey="admin.health.subtitle">
        {report.data !== undefined && (
          <Status type={health.status === 'ok' ? 'success' : 'danger'}>{t(health.status === 'ok' ? 'admin.overview.allOk' : 'admin.overview.degraded')}</Status>
        )}
      </AdminHead>
      <div className="admin-toolbar">
        {report.dataUpdatedAt > 0 && <span className="last-check">{t('admin.pipeline.updated', { time: f.time(report.dataUpdatedAt) })}</span>}
        <Button onClick={() => void report.refetch()} aria-busy={report.isFetching}>
          {t('admin.health.refresh')}
        </Button>
      </div>
      <section className="admin-card" aria-labelledby="health-head">
        <div className="card-head">
          <h2 id="health-head">{t('admin.health.checks')}</h2>
        </div>
        {report.isPending ? (
          <p className="tab-note">{t('common.loading')}</p>
        ) : report.isError && !report.data ? (
          <p className="tab-note">{t(adminErrorKey(report.error))}</p>
        ) : (
          <ul className="health-list">
            {health.checks.map((c, i) => {
              const detail = message(ids[i] ?? '')
              return (
                <li key={`${c.name}-${i}`}>
                  <span className="task-name">
                    <strong>{t(`admin.health.check.${c.name}`)}</strong>
                    {detail && <small className="bidi-isolate">{detail}</small>}
                  </span>
                  <Status type={c.status === 'ok' ? 'success' : c.status === 'warning' ? 'processing' : 'danger'}>{t(`admin.health.status.${c.status}`)}</Status>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </>
  )
}

export function AdminStoragePage() {
  const { t } = useTranslation()
  useDocumentTitle('admin.tabs.storage')
  const storage = useStorageStatus()
  const f = useFormatters()
  const d = storage.data?.drive
  const problem = d?.problem && KNOWN_PROBLEMS.has(d.problem) ? d.problem : 'error'
  return (
    <>
      <AdminHead titleKey="admin.tabs.storage" subtitleKey="admin.storage.subtitle" />
      {storage.isPending ? (
        <p className="tab-note">{t('common.loading')}</p>
      ) : !storage.data || !d ? (
        <div className="tab-note">
          <p>{t(adminErrorKey(storage.error))}</p>
          <Button onClick={() => void storage.refetch()}>{t('common.tryAgain')}</Button>
        </div>
      ) : (
        <>
          <div className="admin-kpis">
            <div className="stat-card">
              <span>{t('admin.storage.connection')}</span>
              <strong>
                <Status type={d.ok ? 'success' : 'danger'}>{t(d.ok ? 'admin.storage.connected' : `admin.storage.problem.${problem}`)}</Status>
              </strong>
              <small className="bidi-isolate">{d.account_email ? displayText(d.account_email) : t('admin.storage.noAccount')}</small>
            </div>
            <div className="stat-card">
              <span>{t('admin.storage.files')}</span>
              <strong>{f.number(storage.data.objects.count)}</strong>
              <small>{t('admin.storage.filesHint')}</small>
            </div>
            <div className="stat-card">
              <span>{t('admin.storage.used')}</span>
              <strong>{f.bytes(storage.data.objects.bytes)}</strong>
              <small>{t('admin.storage.usedHint')}</small>
            </div>
            <div className="stat-card">
              <span>{t('admin.storage.quota')}</span>
              <strong>{typeof d.quota_used === 'number' ? f.bytes(d.quota_used) : '—'}</strong>
              <small>{typeof d.quota_limit === 'number' ? t('admin.storage.quotaOf', { limit: f.bytes(d.quota_limit) }) : t('admin.storage.noLimit')}</small>
            </div>
          </div>
          <div className="secure-note">
            <div>
              <strong>{t('admin.storage.howTitle')}</strong>
              <p>{t('admin.storage.howBody')}</p>
            </div>
          </div>
        </>
      )}
    </>
  )
}
