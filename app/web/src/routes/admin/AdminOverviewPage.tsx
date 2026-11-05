// Admin › Overview (ARC-14a, Make AdminOverview): counts, pipeline, health, recent admin actions.
import { Link } from 'react-router'
import { ArrowUpRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useOverview } from '../../api/admin/users'
import { AdminHead, useFormatters } from '../../components/admin/AdminParts'
import { Status } from '../../components/ui/Status'
import { adminErrorKey, healthSummary } from '../../lib/admin/users'
import { displayText } from '../../lib/text'
import { useDocumentTitle } from '../../lib/useDocumentTitle'

function CardLink({ to, labelKey }: { to: string; labelKey: string }) {
  const { t } = useTranslation()
  return (
    <Link to={to} className="card-link">
      {t(labelKey)} <ArrowUpRight size={13} aria-hidden="true" />
    </Link>
  )
}

export function AdminOverviewPage() {
  const { t } = useTranslation()
  useDocumentTitle('admin.tabs.overview')
  const o = useOverview()
  const f = useFormatters()
  const p = o.pipeline.data
  const health = healthSummary(o.health.data)
  const value = (n: number | undefined) => (n === undefined ? '—' : f.number(n))
  const avg = p?.avg_processing_secs
  const successRate = p && p.counts.done + p.counts.failed > 0 ? Math.round((p.counts.done / (p.counts.done + p.counts.failed)) * 1000) / 10 : null

  return (
    <>
      <AdminHead titleKey="admin.tabs.overview">
        {o.health.isSuccess && (
          <Status type={health.status === 'ok' ? 'success' : 'danger'}>{t(health.status === 'ok' ? 'admin.overview.allOk' : 'admin.overview.degraded')}</Status>
        )}
      </AdminHead>
      <div className="admin-kpis">
        <div className="stat-card">
          <span>{t('admin.overview.users')}</span>
          <strong>{value(o.users.data)}</strong>
          <small>{o.users.isError ? t(adminErrorKey(o.users.error)) : t('admin.overview.usersHint')}</small>
        </div>
        <div className="stat-card">
          <span>{t('admin.overview.meetings')}</span>
          <strong>{value(p?.total)}</strong>
          <small>{successRate === null ? t('admin.overview.noRuns') : t('admin.overview.successRate', { rate: successRate })}</small>
        </div>
        <div className="stat-card">
          <span>{t('admin.overview.inProgress')}</span>
          <strong>{p ? f.number(p.counts.pending + p.counts.processing) : '—'}</strong>
          <small>{t('admin.overview.inProgressHint')}</small>
        </div>
        <div className="stat-card">
          <span>{t('admin.overview.avgTime')}</span>
          <strong>{avg == null ? '—' : t('admin.overview.minutes', { m: Math.max(1, Math.round(avg / 60)) })}</strong>
          <small>{t('admin.overview.avgTimeHint')}</small>
        </div>
      </div>
      <div className="admin-grid">
        <section className="admin-card" aria-labelledby="ov-pipeline">
          <div className="card-head">
            <h2 id="ov-pipeline">{t('admin.overview.pipeline')}</h2>
            <CardLink to="/admin/pipeline" labelKey="admin.overview.viewPipeline" />
          </div>
          {!p ? (
            <p className="tab-note">{o.pipeline.isError ? t(adminErrorKey(o.pipeline.error)) : t('common.loading')}</p>
          ) : (
            <dl className="count-list">
              {(['processing', 'pending', 'stuck', 'failed', 'done'] as const).map((k) => (
                <div key={k} className={k === 'stuck' || k === 'failed' ? (p.counts[k] > 0 ? 'attention' : '') : ''}>
                  <dt>{t(`admin.overview.count.${k}`)}</dt>
                  <dd>{f.number(p.counts[k])}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
        <section className="admin-card" aria-labelledby="ov-health">
          <div className="card-head">
            <h2 id="ov-health">{t('admin.overview.health')}</h2>
            <CardLink to="/admin/health" labelKey="admin.overview.viewHealth" />
          </div>
          {o.health.isPending ? (
            <p className="tab-note">{t('common.loading')}</p>
          ) : o.health.isError ? (
            <p className="tab-note">{t(adminErrorKey(o.health.error))}</p>
          ) : (
            <ul className="health-list">
              {health.checks.map((c) => (
                <li key={c.name}>
                  <span>{t(`admin.health.check.${c.name}`, { defaultValue: c.name })}</span>
                  <Status type={c.status === 'ok' ? 'success' : c.status === 'warning' ? 'processing' : 'danger'}>
                    {t(`admin.health.status.${c.status}`)}
                  </Status>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <section className="admin-card" aria-labelledby="ov-audit">
        <div className="card-head">
          <h2 id="ov-audit">{t('admin.overview.recent')}</h2>
          <CardLink to="/admin/audit" labelKey="admin.overview.viewAudit" />
        </div>
        {o.audit.isPending ? (
          <p className="tab-note">{t('common.loading')}</p>
        ) : !o.audit.data ? (
          <p className="tab-note">{t(adminErrorKey(o.audit.error))}</p>
        ) : o.audit.data.length === 0 ? (
          <p className="tab-note">{t('admin.overview.noRecent')}</p>
        ) : (
          <ul className="timeline">
            {o.audit.data.map((a) => (
              <li className="event" key={a.id}>
                <span className="event-badge">{displayText(a.target_type ?? '—')}</span>
                <strong>
                  {t('admin.overview.auditLine', { actor: displayText(a.actor_email ?? t('admin.overview.system')), action: displayText(a.action) })}
                </strong>
                <small>{f.dateTime(a.created_at)}</small>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}
