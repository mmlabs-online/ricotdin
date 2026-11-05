// Admin › Audit log (ARC-14b, Make LogsAdmin audit): every admin change, newest first. Metadata is
// ids, counts and field names only (§0.9) and renders as text.
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useAuditLog } from '../../api/admin/ops'
import { AdminHead, AdminPagination, useFormatters, useUrlState } from '../../components/admin/AdminParts'
import { LogFilters } from '../../components/admin/LogFilters'
import { Button } from '../../components/ui/Button'
import { dateInput, metadataText, uuidOrNull } from '../../lib/admin/ops'
import { adminErrorKey } from '../../lib/admin/users'
import { displayText } from '../../lib/text'
import { useDocumentTitle } from '../../lib/useDocumentTitle'

const PER_PAGE = 25

export function AdminAuditPage() {
  const { t } = useTranslation()
  useDocumentTitle('admin.tabs.audit')
  const url = useUrlState()
  const actor = uuidOrNull(url.get('actor'))
  const action = (url.get('action') ?? '').slice(0, 64) || null
  const from = dateInput(url.get('from'))
  const to = dateInput(url.get('to'))
  const log = useAuditLog({ actor, action, from, to, page: url.page, perPage: PER_PAGE })
  const f = useFormatters()

  return (
    <>
      <AdminHead titleKey="admin.tabs.audit" subtitleKey="admin.audit.subtitle" />
      <LogFilters
        values={{ type: action ?? '', from: from ?? '', to: to ?? '' }}
        onApply={(v) => url.set({ action: v.type || null, from: v.from || null, to: v.to || null, page: 1 })}
        typeOptions={null}
        typeLabel="admin.audit.action"
      />
      {actor && (
        <p className="filter-chip">
          {t('admin.audit.forActor', { email: log.data?.logs[0]?.actor_email ? displayText(log.data.logs[0].actor_email) : actor })}{' '}
          <Button variant="ghost" onClick={() => url.set({ actor: null, page: 1 })}>
            {t('admin.audit.allActors')}
          </Button>
        </p>
      )}
      <section className="admin-card">
        {log.isPending ? (
          <p className="tab-note">{t('common.loading')}</p>
        ) : !log.data ? (
          <div className="tab-note">
            <p>{t(adminErrorKey(log.error))}</p>
            <Button onClick={() => void log.refetch()}>{t('common.tryAgain')}</Button>
          </div>
        ) : log.data.logs.length === 0 ? (
          <p className="tab-note">{t('admin.audit.empty')}</p>
        ) : (
          <div className="table-scroll" tabIndex={0} role="region" aria-label={t('admin.tabs.audit')}>
            <table className="admin-table audit-table">
              <thead>
                <tr>
                  <th scope="col">{t('admin.audit.col.when')}</th>
                  <th scope="col">{t('admin.audit.col.actor')}</th>
                  <th scope="col">{t('admin.audit.col.action')}</th>
                  <th scope="col">{t('admin.audit.col.target')}</th>
                  <th scope="col">{t('admin.audit.col.details')}</th>
                  <th scope="col">{t('admin.audit.col.ip')}</th>
                </tr>
              </thead>
              <tbody>
                {log.data.logs.map((a) => {
                  const meta = metadataText(a.metadata)
                  const userTarget = a.target_type === 'user' && uuidOrNull(a.target_id)
                  return (
                    <tr key={a.id}>
                      <td>{f.dateTime(a.created_at)}</td>
                      <th scope="row" className="bidi-isolate">
                        {a.actor_email ? displayText(a.actor_email) : t('admin.overview.system')}
                      </th>
                      <td>
                        <code>{displayText(a.action)}</code>
                      </td>
                      <td className="wrap">
                        {userTarget ? (
                          <Link className="user-link" to={`/admin/users/${encodeURIComponent(userTarget)}`}>
                            {t('admin.audit.userTarget')}
                          </Link>
                        ) : (
                          <span>{a.target_type ? displayText(a.target_type) : '—'}</span>
                        )}
                        {a.target_id && <small className="cell-sub">{displayText(a.target_id)}</small>}
                      </td>
                      <td className="wrap">{meta ? <code className="log-meta">{displayText(meta)}</code> : '—'}</td>
                      <td>{a.ip_address ? displayText(a.ip_address) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {log.data && <AdminPagination page={url.page} perPage={PER_PAGE} total={log.data.total} onPage={(p) => url.set({ page: p })} />}
    </>
  )
}
