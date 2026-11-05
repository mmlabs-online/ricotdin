// Admin › Activity (ARC-14b, Make LogsAdmin): what users did, newest first. Users write some of
// these rows themselves (POST /activity), so every field renders as plain text (§0.9).
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useActivityFeed } from '../../api/admin/ops'
import { AdminHead, AdminPagination, useClampPage, useFormatters, useUrlState } from '../../components/admin/AdminParts'
import { LogFilters } from '../../components/admin/LogFilters'
import { Button } from '../../components/ui/Button'
import { dateInput, EVENT_TYPES, eventKey, metadataText, uuidOrNull } from '../../lib/admin/ops'
import { adminErrorKey } from '../../lib/admin/users'
import { displayText } from '../../lib/text'
import { useDocumentTitle } from '../../lib/useDocumentTitle'

const PER_PAGE = 25

export function AdminActivityPage() {
  const { t } = useTranslation()
  useDocumentTitle('admin.tabs.activity')
  const url = useUrlState()
  const userId = uuidOrNull(url.get('userId'))
  const type = url.get('type')
  const eventType = type && EVENT_TYPES.includes(type) ? type : null
  const from = dateInput(url.get('from'))
  const to = dateInput(url.get('to'))
  const feed = useActivityFeed({ userId, eventType, from, to, page: url.page, perPage: PER_PAGE })
  const f = useFormatters()
  useClampPage(feed.data?.total, PER_PAGE, url.page, feed.data?.rows.length ?? 1, (p) => url.set({ page: p }))
  // the email only from rows of this filter (not the previous answer kept while loading)
  const first = feed.isPlaceholderData ? undefined : feed.data?.rows[0]
  const chipEmail = first && first.user_id === userId && first.user_email ? displayText(first.user_email) : null

  return (
    <>
      <AdminHead titleKey="admin.tabs.activity" subtitleKey="admin.activity.subtitle" />
      <LogFilters
        values={{ type: eventType ?? '', from: from ?? '', to: to ?? '' }}
        onApply={(v) => url.set({ type: v.type || null, from: v.from || null, to: v.to || null, page: 1 })}
        typeOptions={EVENT_TYPES.map((e) => ({ value: e, label: t(eventKey(e)) }))}
        typeLabel="admin.activity.type"
        allLabel="admin.activity.allTypes"
      />
      {userId && (
        <p className="filter-chip">
          {t('admin.activity.forUser', { email: chipEmail ?? userId })}{' '}
          <Button variant="ghost" onClick={() => url.set({ userId: null, page: 1 })}>
            {t('admin.activity.allUsers')}
          </Button>
        </p>
      )}
      <section className="admin-card timeline-card">
        {feed.isPending ? (
          <p className="tab-note">{t('common.loading')}</p>
        ) : !feed.data ? (
          <div className="tab-note">
            <p>{t(adminErrorKey(feed.error))}</p>
            <Button onClick={() => void feed.refetch()}>{t('common.tryAgain')}</Button>
          </div>
        ) : feed.data.rows.length === 0 ? (
          <p className="tab-note">{t('admin.activity.empty')}</p>
        ) : (
          <ul className="timeline">
            {feed.data.rows.map((a) => {
              const meta = metadataText(a.metadata)
              return (
                <li className="event log-event" key={a.id}>
                  <span className="event-badge">{t(eventKey(a.event_type))}</span>
                  <span className="log-main">
                    <Link className="user-link bidi-isolate" to={`/admin/users/${encodeURIComponent(a.user_id)}`}>
                      {a.user_email ? displayText(a.user_email) : t('admin.activity.deletedUser')}
                    </Link>
                    {a.meeting_title && <span className="bidi-isolate log-meeting">{displayText(a.meeting_title)}</span>}
                    {meta && <code className="log-meta">{displayText(meta)}</code>}
                  </span>
                  <small>
                    <time dateTime={a.created_at}>{f.dateTime(a.created_at)}</time>
                  </small>
                </li>
              )
            })}
          </ul>
        )}
      </section>
      {feed.data && <AdminPagination page={url.page} perPage={PER_PAGE} total={feed.data.total} onPage={(p) => url.set({ page: p })} />}
    </>
  )
}
