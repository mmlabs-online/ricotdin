// Admin › Usage (ARC-14b, Make UsageAdmin): AI provider usage for a date range (tokens and audio
// seconds are never added together, CLAUDE.md §9e), daily charts with a table view, and meeting /
// storage totals.
import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useAiUsage, useStorageUsage } from '../../api/admin/ops'
import { AdminHead, useFormatters, useUrlState } from '../../components/admin/AdminParts'
import { Button } from '../../components/ui/Button'
import { dailyBars, dateInput, defaultRange, providerSlot, rangeProblem, usageSummary, type DailyTotal, type UsageRow } from '../../lib/admin/ops'
import { adminErrorKey } from '../../lib/admin/users'
import { displayText } from '../../lib/text'
import { useDocumentTitle } from '../../lib/useDocumentTitle'

const PROVIDERS = new Set(['gemini', 'openai', 'grok', 'speechmatics', 'gemini-embedding'])
function useProviderName() {
  const { t } = useTranslation()
  return (p: string) => (PROVIDERS.has(p) ? t(`admin.usage.provider.${p}`) : displayText(p))
}

export function AdminUsagePage() {
  const { t } = useTranslation()
  useDocumentTitle('admin.tabs.usage')
  const url = useUrlState()
  const [fallback] = useState(() => defaultRange(new Date()))
  const from = dateInput(url.get('from')) ?? fallback.from
  const to = dateInput(url.get('to')) ?? fallback.to
  const byOperation = url.get('by') === 'operation'
  const applied = rangeProblem(from, to) ? fallback : { from, to }
  const usage = useAiUsage({ ...applied, byOperation })
  const storage = useStorageUsage()
  const f = useFormatters()
  const [draft, setDraft] = useState({ from: applied.from, to: applied.to, byOperation })
  // the URL changed (Back / a link): show its values in the fields
  const [shown, setShown] = useState(`${applied.from}|${applied.to}|${byOperation}`)
  if (shown !== `${applied.from}|${applied.to}|${byOperation}`) {
    setShown(`${applied.from}|${applied.to}|${byOperation}`)
    setDraft({ from: applied.from, to: applied.to, byOperation })
  }
  const [problem, setProblem] = useState<string | null>(null)
  const [tries, setTries] = useState(0)
  const ids = { from: useId(), to: useId(), op: useId(), err: useId() }

  function apply(e: FormEvent) {
    e.preventDefault()
    const p = rangeProblem(draft.from, draft.to)
    setProblem(p)
    setTries((n) => n + 1)
    if (!p) url.set({ from: draft.from, to: draft.to, by: draft.byOperation ? 'operation' : null })
  }

  const rows = usage.data?.rows ?? []
  const s = usageSummary(rows)
  const minutes = (sec: number) => f.minutes(sec)
  // the operation column follows the data shown (the previous answer stays while the next loads)
  const showOperation = rows.some((r) => r.operation !== null)

  return (
    <>
      <AdminHead titleKey="admin.tabs.usage" subtitleKey="admin.usage.subtitle" />
      <form className="admin-toolbar usage-range" onSubmit={apply} noValidate>
        <label htmlFor={ids.from} className="toolbar-label">
          {t('admin.usage.from')}
        </label>
        <input id={ids.from} type="date" value={draft.from} min="1970-01-01" max="2100-12-31" onChange={(e) => setDraft({ ...draft, from: e.target.value })} aria-invalid={problem !== null} aria-describedby={problem ? ids.err : undefined} />
        <label htmlFor={ids.to} className="toolbar-label">
          {t('admin.usage.to')}
        </label>
        <input id={ids.to} type="date" value={draft.to} min="1970-01-01" max="2100-12-31" onChange={(e) => setDraft({ ...draft, to: e.target.value })} aria-invalid={problem !== null} aria-describedby={problem ? ids.err : undefined} />
        <label className="toggle-label" htmlFor={ids.op}>
          <input id={ids.op} type="checkbox" checked={draft.byOperation} onChange={(e) => setDraft({ ...draft, byOperation: e.target.checked })} /> {t('admin.usage.byOperation')}
        </label>
        <Button type="submit" variant="primary" aria-busy={usage.isFetching}>
          {t('admin.usage.apply')}
        </Button>
        <div id={ids.err} className="usage-error">
          {problem && (
            <p key={tries} className="form-note error" role="alert">
              {t(problem, { days: 400 })}
            </p>
          )}
        </div>
      </form>
      <p className="tab-note range-note">{t('admin.usage.showing', { from: f.day(applied.from), to: f.day(applied.to) })}</p>

      {usage.isPending ? (
        <p className="tab-note">{t('common.loading')}</p>
      ) : !usage.data ? (
        <div className="tab-note">
          <p>{t(adminErrorKey(usage.error))}</p>
          <Button onClick={() => void usage.refetch()}>{t('common.tryAgain')}</Button>
        </div>
      ) : (
        <>
          <div className="admin-kpis usage-kpis">
            <div className="stat-card">
              <span>{t('admin.usage.aiCalls')}</span>
              <strong>{f.number(s.tokenCalls)}</strong>
              <small>{t('admin.usage.totalTokens', { n: f.number(s.totalTokens) })}</small>
            </div>
            <div className="stat-card">
              <span>{t('admin.usage.inOut')}</span>
              <strong>{t('admin.usage.inOutValue', { input: f.number(s.inputTokens), output: f.number(s.outputTokens) })}</strong>
              <small>{t('admin.usage.tokensOnly')}</small>
            </div>
            <div className="stat-card">
              <span>{t('admin.usage.audio')}</span>
              <strong>{t('admin.usage.minutesValue', { n: minutes(s.audioSeconds) })}</strong>
              <small>{t('admin.usage.audioCalls', { n: f.number(s.audioCalls) })}</small>
            </div>
            <div className="stat-card">
              <span>{t('admin.usage.limitedErrors')}</span>
              <strong>{t('admin.usage.limitedErrorsValue', { limited: f.number(s.rateLimited), errors: f.number(s.errors) })}</strong>
              <small>{t('admin.usage.ofCalls', { n: f.number(s.calls) })}</small>
            </div>
          </div>
          <UsageChart daily={usage.data.dailyTotals} unit="tokens" range={applied} />
          <UsageChart daily={usage.data.dailyTotals} unit="audio_seconds" range={applied} />
          <div className="meter-stack">
            <MeterTable rows={rows.filter((r) => r.unit === 'tokens')} unit="tokens" byOperation={showOperation} />
            <MeterTable rows={rows.filter((r) => r.unit === 'audio_seconds')} unit="audio_seconds" byOperation={showOperation} />
          </div>
        </>
      )}

      <section className="admin-card" aria-labelledby="usage-meetings">
        <div className="card-head">
          <h2 id="usage-meetings">{t('admin.usage.meetingsTitle')}</h2>
        </div>
        {storage.isPending ? (
          <p className="tab-note">{t('common.loading')}</p>
        ) : !storage.data ? (
          <p className="tab-note">{t(adminErrorKey(storage.error))}</p>
        ) : (
          <dl className="count-list">
            <div>
              <dt>{t('admin.usage.meetingsTotal')}</dt>
              <dd>{f.number(storage.data.meetings.total)}</dd>
            </div>
            <div>
              <dt>{t('admin.usage.last7')}</dt>
              <dd>{f.number(storage.data.meetings.last7Days)}</dd>
            </div>
            <div>
              <dt>{t('admin.usage.last30')}</dt>
              <dd>{f.number(storage.data.meetings.last30Days)}</dd>
            </div>
            <div>
              <dt>{t('admin.usage.failureRate')}</dt>
              <dd>{t('admin.usage.percent', { n: f.number(Math.round(storage.data.meetings.failureRate * 1000) / 10) })}</dd>
            </div>
            <div>
              <dt>{t('admin.usage.files')}</dt>
              <dd>{f.number(storage.data.storage.fileCount)}</dd>
            </div>
            <div>
              <dt>{t('admin.usage.stored')}</dt>
              <dd>{f.bytes(storage.data.storage.totalBytes)}</dd>
            </div>
          </dl>
        )}
      </section>
    </>
  )
}

/** Daily stacked bars for one unit. Hover shows the day; the same numbers are in the table view. */
function UsageChart({ daily, unit, range }: { daily: DailyTotal[]; unit: 'tokens' | 'audio_seconds'; range: { from: string; to: string } }) {
  const { t } = useTranslation()
  const f = useFormatters()
  const name = useProviderName()
  const head = useId()
  const bars = dailyBars(daily, unit, range)
  const [hover, setHover] = useState<(typeof bars.days)[number] | null>(null)
  const value = (q: number) => (unit === 'tokens' ? t('admin.usage.tokensValue', { n: f.number(Math.round(q)) }) : t('admin.usage.minutesValue', { n: f.minutes(q) }))
  const title = unit === 'tokens' ? 'admin.usage.chartTokens' : 'admin.usage.chartAudio'
  return (
    <section className="admin-card" aria-labelledby={head}>
      <div className="card-head">
        <h2 id={head}>{t(title)}</h2>
        {bars.providers.length > 0 && (
          <ul className="chart-legend" aria-label={t('admin.usage.legend')}>
            {bars.providers.map((p) => (
              <li key={p}>
                <i className={`series-${providerSlot(p)}`} aria-hidden="true" /> {name(p)}
              </li>
            ))}
          </ul>
        )}
      </div>
      {bars.max === 0 ? (
        <p className="tab-note">{t('admin.usage.noData')}</p>
      ) : (
        <>
          <div className="usage-chart" onMouseLeave={() => setHover(null)} role="img" aria-label={t('admin.usage.chartSummary', { days: bars.days.filter((d) => d.total > 0).length, max: value(bars.max) })}>
            {bars.days.map((d) => (
              <div className={d.date === hover?.date ? 'usage-day active' : 'usage-day'} key={d.date} onMouseEnter={() => setHover(d)}>
                <div className="usage-stack" style={{ height: `${(d.total / bars.max) * 100}%` }}>
                  {d.parts.map((p) => (
                    <i key={p.provider} className={`series-${providerSlot(p.provider)}`} style={{ flexGrow: p.quantity }} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="usage-axis" aria-hidden="true">
            <span>{f.day(bars.days[0]?.date ?? range.from)}</span>
            <span>{f.day(bars.days[bars.days.length - 1]?.date ?? range.to)}</span>
          </div>
          {/* the pointed day, below the chart (never over other content); keyboard users have the table */}
          <p className="usage-dayline" aria-hidden="true">
            {hover ? (
              <>
                <strong>{f.day(hover.date)}</strong>
                {hover.parts.length === 0 ? <span>{t('admin.usage.noUsageDay')}</span> : hover.parts.map((p) => <span key={p.provider}>{t('admin.usage.tipLine', { name: name(p.provider), value: value(p.quantity) })}</span>)}
              </>
            ) : (
              <span>{t('admin.usage.pointHint')}</span>
            )}
          </p>
          <details className="table-view">
            <summary>{t('admin.usage.showTableOf', { title: t(title) })}</summary>
            <div className="table-scroll" tabIndex={0} role="region" aria-label={t('admin.usage.tableOf', { title: t(title) })}>
              <table className="admin-table">
                <thead>
                  <tr>
                    <th scope="col">{t('admin.usage.col.date')}</th>
                    {bars.providers.map((p) => (
                      <th scope="col" key={p}>
                        {name(p)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {bars.days.filter((d) => d.total > 0).map((d) => (
                    <tr key={d.date}>
                      <th scope="row">{f.day(d.date)}</th>
                      {bars.providers.map((p) => {
                        const part = d.parts.find((x) => x.provider === p)
                        return (
                          <td className="num" key={p}>
                            {part ? value(part.quantity) : '—'}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  )
}

function MeterTable({ rows, unit, byOperation }: { rows: UsageRow[]; unit: 'tokens' | 'audio_seconds'; byOperation: boolean }) {
  const { t } = useTranslation()
  const f = useFormatters()
  const name = useProviderName()
  const head = useId()
  const title = unit === 'tokens' ? 'admin.usage.tokenTable' : 'admin.usage.audioTable'
  return (
    <section className="admin-card compact">
      <div className="card-head">
        <h2 id={head}>{t(title)}</h2>
      </div>
      {rows.length === 0 ? (
        <p className="tab-note">{t('admin.usage.noData')}</p>
      ) : (
        <div className="table-scroll" tabIndex={0} role="region" aria-labelledby={head}>
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">{t('admin.usage.col.model')}</th>
                {byOperation && <th scope="col">{t('admin.usage.col.operation')}</th>}
                <th scope="col">{t('admin.usage.col.key')}</th>
                <th scope="col">{t('admin.usage.col.calls')}</th>
                {unit === 'tokens' ? (
                  <>
                    <th scope="col">{t('admin.usage.col.input')}</th>
                    <th scope="col">{t('admin.usage.col.output')}</th>
                    <th scope="col">{t('admin.usage.col.total')}</th>
                  </>
                ) : (
                  <th scope="col">{t('admin.usage.col.minutes')}</th>
                )}
                <th scope="col">{t('admin.usage.col.limited')}</th>
                <th scope="col">{t('admin.usage.col.errors')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.provider}|${r.model}|${r.operation ?? ''}|${r.key_id ?? ''}|${i}`}>
                  <th scope="row">
                    {name(r.provider)}
                    <small className="cell-sub">{displayText(r.model)}</small>
                  </th>
                  {byOperation && <td>{r.operation ? displayText(r.operation) : '—'}</td>}
                  <td>{r.key_label ? t('admin.usage.keyLabel', { label: displayText(r.key_label), last4: displayText(r.key_last4 ?? '') }) : t('admin.usage.envKey')}</td>
                  <td className="num">{f.number(r.calls)}</td>
                  {unit === 'tokens' ? (
                    <>
                      <td className="num">{f.number(r.total_input_tokens ?? 0)}</td>
                      <td className="num">{f.number(r.total_output_tokens ?? 0)}</td>
                      <td className="num">{f.number(r.total_tokens ?? 0)}</td>
                    </>
                  ) : (
                    <td className="num">{f.minutes(r.total_audio_seconds ?? 0)}</td>
                  )}
                  <td className={`num${r.rate_limited_count ? ' attention-text' : ''}`}>{f.number(r.rate_limited_count)}</td>
                  <td className={`num${r.error_count ? ' attention-text' : ''}`}>{f.number(r.error_count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
