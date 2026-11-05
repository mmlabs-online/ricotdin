// Filters of the activity and audit logs (ARC-14b): type + date range, applied together with a
// button (3.2.2: nothing changes while typing).
import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { dateInput } from '../../lib/admin/ops'
import { Button } from '../ui/Button'

type Filters = { type: string; from: string; to: string }

export function LogFilters({
  values,
  onApply,
  typeOptions,
  typeLabel,
  allLabel,
}: {
  values: Filters
  onApply: (v: Filters) => void
  typeOptions: { value: string; label: string }[] | null
  typeLabel: string
  allLabel?: string
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(values)
  const [shown, setShown] = useState(values)
  if (shown.type !== values.type || shown.from !== values.from || shown.to !== values.to) {
    setShown(values)
    setDraft(values)
  }
  const [bad, setBad] = useState(false)
  const [tries, setTries] = useState(0)
  const ids = { type: useId(), from: useId(), to: useId(), err: useId() }

  function submit(e: FormEvent) {
    e.preventDefault()
    const wrong = (draft.from !== '' && !dateInput(draft.from)) || (draft.to !== '' && !dateInput(draft.to)) || (draft.from !== '' && draft.to !== '' && draft.from > draft.to)
    setBad(wrong)
    setTries((n) => n + 1)
    if (!wrong) onApply({ ...draft, type: draft.type.trim() })
  }

  return (
    <form className="admin-toolbar log-filters" onSubmit={submit} noValidate>
      <label htmlFor={ids.type} className="toolbar-label">
        {t(typeLabel)}
      </label>
      {typeOptions ? (
        <select id={ids.type} value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
          <option value="">{t(allLabel ?? 'admin.activity.allTypes')}</option>
          {typeOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input id={ids.type} value={draft.type} maxLength={64} onChange={(e) => setDraft({ ...draft, type: e.target.value })} />
      )}
      <label htmlFor={ids.from} className="toolbar-label">
        {t('admin.usage.from')}
      </label>
      <input id={ids.from} type="date" value={draft.from} min="1970-01-01" max="2100-12-31" onChange={(e) => setDraft({ ...draft, from: e.target.value })} aria-invalid={bad} aria-describedby={bad ? ids.err : undefined} />
      <label htmlFor={ids.to} className="toolbar-label">
        {t('admin.usage.to')}
      </label>
      <input id={ids.to} type="date" value={draft.to} min="1970-01-01" max="2100-12-31" onChange={(e) => setDraft({ ...draft, to: e.target.value })} aria-invalid={bad} aria-describedby={bad ? ids.err : undefined} />
      <Button type="submit" variant="primary">
        {t('admin.usage.apply')}
      </Button>
      <div id={ids.err} className="usage-error">
        {bad && (
          <p key={tries} className="form-note error" role="alert">
            {t('admin.usage.errors.filterDates')}
          </p>
        )}
      </div>
    </form>
  )
}
