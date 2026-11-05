// Admin › Features (ARC-14c, v1 §9h): the feature registry. List with module / status / search
// filters (in the URL), an edit panel that sends only changed fields, and a create form. Feature
// text is shown as text (§0.9), the content field as a plain textarea.
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useFeatureMutations, useFeatures, type Feature } from '../../api/admin/config'
import { AdminHead, NoticeBanner, useFormatters, useNotice, useUrlState } from '../../components/admin/AdminParts'
import { Button } from '../../components/ui/Button'
import { Status } from '../../components/ui/Status'
import { FEATURE_ARRAYS, featureChanges, featureCreateProblem, listText, parseList, type FeatureFields } from '../../lib/admin/config'
import { configErrorKey } from '../../lib/admin/config'
import { adminErrorKey } from '../../lib/admin/users'
import { displayText } from '../../lib/text'
import { useDocumentTitle } from '../../lib/useDocumentTitle'

const STATUSES = ['done', 'partial', 'not_started'] as const
const PRIORITIES = ['high', 'medium', 'low'] as const
type Notify = (key: string | null, kind?: 'success' | 'warning' | 'error', values?: Record<string, unknown>) => void

export function AdminFeaturesPage() {
  const { t } = useTranslation()
  useDocumentTitle('admin.tabs.features')
  const url = useUrlState()
  const features = useFeatures()
  const [notice, setNotice] = useNotice()
  const [draft, setDraft] = useState(url.get('q') ?? '')
  const [seenQ, setSeenQ] = useState(url.get('q') ?? '')
  if (seenQ !== (url.get('q') ?? '')) {
    setSeenQ(url.get('q') ?? '')
    setDraft(url.get('q') ?? '')
  }
  const ids = { search: useId(), module: useId(), status: useId(), caption: useId() }
  const module = url.get('module') ?? ''
  const status = url.get('status') ?? ''
  const q = (url.get('q') ?? '').trim().toLowerCase()
  const selected = url.get('key')
  const all = features.data ?? []
  const modules = useMemo(() => [...new Set((features.data ?? []).map((f) => f.module_prefix))].sort(), [features.data])
  const shown = all.filter(
    (f) =>
      (!module || f.module_prefix === module) &&
      (!status || f.status === status) &&
      (!q || f.key.toLowerCase().includes(q) || f.title.toLowerCase().includes(q) || (f.description ?? '').toLowerCase().includes(q)),
  )
  const current = all.find((f) => f.key === selected) ?? null

  return (
    <>
      <AdminHead titleKey="admin.tabs.features" subtitleKey="admin.features.subtitle" />
      <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} />
      <div className="admin-toolbar log-filters">
        <form
          className="search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault()
            url.set({ q: draft.trim() || null })
          }}
        >
          <label htmlFor={ids.search} className="sr-only">
            {t('admin.features.search')}
          </label>
          <input id={ids.search} type="search" value={draft} maxLength={100} onChange={(e) => setDraft(e.target.value)} placeholder={t('admin.features.searchPlaceholder')} />
          <button type="submit" className="sr-only">
            {t('admin.users.searchSubmit')}
          </button>
        </form>
        <label htmlFor={ids.module} className="toolbar-label">
          {t('admin.features.module')}
        </label>
        <select id={ids.module} value={module} onChange={(e) => url.set({ module: e.target.value || null })}>
          <option value="">{t('admin.features.allModules')}</option>
          {modules.map((m) => (
            <option key={m} value={m}>
              {displayText(m)}
            </option>
          ))}
        </select>
        <label htmlFor={ids.status} className="toolbar-label">
          {t('admin.features.status')}
        </label>
        <select id={ids.status} value={status} onChange={(e) => url.set({ status: e.target.value || null })}>
          <option value="">{t('admin.features.allStatuses')}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`admin.features.statuses.${s}`)}
            </option>
          ))}
        </select>
      </div>

      {features.isPending ? (
        <p className="tab-note">{t('common.loading')}</p>
      ) : !features.data ? (
        <div className="tab-note">
          <p>{t(adminErrorKey(features.error))}</p>
          <Button onClick={() => void features.refetch()}>{t('common.tryAgain')}</Button>
        </div>
      ) : (
        <div className="feature-split">
          <div>
            {shown.length === 0 ? (
              <p className="tab-note">{t('admin.features.empty')}</p>
            ) : (
              <div className="table-scroll" tabIndex={0} role="region" aria-labelledby={ids.caption}>
                <table className="admin-table">
                  <caption className="sr-only" id={ids.caption}>
                    {t('admin.features.caption', { count: shown.length })}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('admin.features.col.key')}</th>
                      <th scope="col">{t('admin.features.col.title')}</th>
                      <th scope="col">{t('admin.features.col.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((f) => (
                      <tr key={f.id} aria-current={f.key === selected ? 'true' : undefined}>
                        <th scope="row">
                          <button type="button" className="link-button" data-feature={f.key} onClick={() => url.set({ key: f.key })}>
                            {displayText(f.key)}
                          </button>
                        </th>
                        <td className="wrap bidi-isolate">{displayText(f.title)}</td>
                        <td>
                          <FeatureStatus status={f.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div>
            {current ? (
              <FeatureEditor
                key={current.id}
                feature={current}
                onNotice={setNotice}
                onClose={() => {
                  url.set({ key: null })
                  // back to the row that opened the editor
                  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-feature="${CSS.escape(current.key)}"]`)?.focus())
                }}
              />
            ) : selected ? (
              <p className="tab-note">{t('admin.features.notFound')}</p>
            ) : (
              <FeatureCreate modules={all} onNotice={setNotice} onCreated={(key) => url.set({ key })} />
            )}
          </div>
        </div>
      )}
    </>
  )
}

function FeatureStatus({ status }: { status: string }) {
  const { t } = useTranslation()
  const s = (STATUSES as readonly string[]).includes(status) ? status : 'not_started'
  return <Status type={s === 'done' ? 'success' : s === 'partial' ? 'processing' : 'danger'}>{t(`admin.features.statuses.${s}`)}</Status>
}

const fieldsOf = (f: Feature): FeatureFields => ({
  title: f.title,
  description: f.description,
  content: f.content,
  status: f.status,
  priority: f.priority,
  note_tags: f.note_tags ?? [],
  depends_on: f.depends_on ?? [],
  blocks: f.blocks ?? [],
  key_files: f.key_files ?? [],
  change_note: f.change_note,
})

function FeatureEditor({ feature, onNotice, onClose }: { feature: Feature; onNotice: Notify; onClose: () => void }) {
  const { t } = useTranslation()
  const f = useFormatters()
  const { update } = useFeatureMutations()
  const original = fieldsOf(feature)
  const listsOf = (o: FeatureFields) => Object.fromEntries(FEATURE_ARRAYS.map((k) => [k, listText(o[k])])) as Record<(typeof FEATURE_ARRAYS)[number], string>
  const [draft, setDraft] = useState(original)
  const [lists, setLists] = useState(() => listsOf(original))
  // a saved version replaces the draft without remounting (focus stays on Save)
  const [seen, setSeen] = useState(feature.updated_at)
  if (seen !== feature.updated_at) {
    setSeen(feature.updated_at)
    setDraft(original)
    setLists(listsOf(original))
  }
  const headRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => headRef.current?.focus(), []) // opening a feature moves focus to its editor
  const [problem, setProblem] = useState<string | null>(null)
  const [tries, setTries] = useState(0)
  const id = useId()
  const head = `${id}-head`
  const set = <K extends keyof FeatureFields>(k: K, v: FeatureFields[K]) => setDraft((d) => ({ ...d, [k]: v }))

  function submit(e: FormEvent) {
    e.preventDefault()
    if (update.isPending) return
    const next = { ...draft, ...Object.fromEntries(FEATURE_ARRAYS.map((k) => [k, parseList(lists[k])])) } as FeatureFields
    setTries((n) => n + 1)
    if (!next.title.trim()) {
      setProblem('admin.features.errors.title')
      document.getElementById(`${id}-title`)?.focus()
      return
    }
    setProblem(null)
    const changes = featureChanges(original, next)
    if (Object.keys(changes).length === 0) {
      onNotice('admin.features.noChanges', 'warning')
      return
    }
    update
      .mutateAsync({ key: feature.key, changes })
      .then(() => onNotice('admin.features.saved', 'success', { key: displayText(feature.key) }))
      .catch((err: unknown) => onNotice(configErrorKey(err), 'error'))
  }

  return (
    <section className="admin-card feature-editor" aria-labelledby={head}>
      <div className="card-head">
        <h2 id={head} ref={headRef} tabIndex={-1}>
          {t('admin.features.editTitle', { key: displayText(feature.key) })}
        </h2>
        <Button variant="ghost" onClick={onClose}>
          {t('admin.features.close')}
        </Button>
      </div>
      <p className="tab-note">
        {t('admin.features.meta', { module: displayText(feature.module_name), time: f.dateTime(feature.updated_at), by: displayText(feature.updated_by ?? '—') })}
      </p>
      <form onSubmit={submit} noValidate className="feature-form">
        <div className="field-row">
          <label htmlFor={`${id}-title`}>{t('admin.features.col.title')}</label>
          <input id={`${id}-title`} value={draft.title} maxLength={300} onChange={(e) => set('title', e.target.value)} aria-invalid={problem !== null} aria-describedby={problem ? `${id}-err` : undefined} />
        </div>
        <div className="field-pair">
          <div className="field-row">
            <label htmlFor={`${id}-status`}>{t('admin.features.status')}</label>
            <select id={`${id}-status`} value={draft.status} onChange={(e) => set('status', e.target.value)}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`admin.features.statuses.${s}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="field-row">
            <label htmlFor={`${id}-priority`}>{t('admin.features.priority')}</label>
            <select id={`${id}-priority`} value={draft.priority ?? ''} onChange={(e) => set('priority', e.target.value || null)}>
              <option value="">{t('admin.features.noPriority')}</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {t(`admin.features.priorities.${p}`)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field-row">
          <label htmlFor={`${id}-desc`}>{t('admin.features.description')}</label>
          <textarea id={`${id}-desc`} rows={3} maxLength={5000} value={draft.description ?? ''} onChange={(e) => set('description', e.target.value)} />
        </div>
        {FEATURE_ARRAYS.map((k) => (
          <div className="field-row" key={k}>
            <label htmlFor={`${id}-${k}`}>{t(`admin.features.lists.${k}`)}</label>
            <textarea id={`${id}-${k}`} rows={2} value={lists[k]} onChange={(e) => setLists((l) => ({ ...l, [k]: e.target.value }))} aria-describedby={`${id}-listhint`} />
          </div>
        ))}
        <p className="tab-note" id={`${id}-listhint`}>
          {t('admin.features.listHint')}
        </p>
        <div className="field-row">
          <label htmlFor={`${id}-content`}>{t('admin.features.content')}</label>
          <textarea id={`${id}-content`} rows={10} maxLength={200000} value={draft.content ?? ''} onChange={(e) => set('content', e.target.value)} spellCheck={false} />
        </div>
        <div className="field-row">
          <label htmlFor={`${id}-note`}>{t('admin.features.changeNote')}</label>
          <input id={`${id}-note`} value={draft.change_note ?? ''} maxLength={2000} onChange={(e) => set('change_note', e.target.value)} />
        </div>
        <div id={`${id}-err`}>
          {problem && (
            <p key={tries} className="form-note error" role="alert">
              {t(problem)}
            </p>
          )}
        </div>
        <Button type="submit" variant="primary" aria-disabled={update.isPending} aria-busy={update.isPending}>
          {t('admin.features.save')}
        </Button>
      </form>
    </section>
  )
}

function FeatureCreate({ modules, onNotice, onCreated }: { modules: Feature[]; onNotice: Notify; onCreated: (key: string) => void }) {
  const { t } = useTranslation()
  const { create } = useFeatureMutations()
  const qc = useQueryClient()
  const [v, setV] = useState({ key: '', module_prefix: '', module_name: '', title: '', status: 'not_started' })
  const [problem, setProblem] = useState<string | null>(null)
  const [tries, setTries] = useState(0)
  const id = useId()
  // the one field at fault (3.3.1): the first empty one, or the key / prefix
  const badField =
    problem === 'admin.features.errors.key' ? 'key' : problem === 'admin.features.errors.prefix' ? 'module_prefix' : problem ? (['key', 'module_prefix', 'module_name', 'title'] as const).find((k) => !v[k].trim()) : undefined
  const set = (k: keyof typeof v, value: string) =>
    setV((d) => {
      const next = { ...d, [k]: value }
      // a known prefix fills its module name
      if (k === 'module_prefix') {
        const known = modules.find((m) => m.module_prefix === value.trim().toUpperCase())
        if (known && !d.module_name) next.module_name = known.module_name
      }
      return next
    })

  function submit(e: FormEvent) {
    e.preventDefault()
    if (create.isPending) return
    const p = featureCreateProblem(v)
    setProblem(p)
    setTries((n) => n + 1)
    if (p) {
      const field = p === 'admin.features.errors.key' ? 'key' : p === 'admin.features.errors.prefix' ? 'module_prefix' : (['key', 'module_prefix', 'module_name', 'title'] as const).find((k) => !v[k].trim())
      document.getElementById(`${id}-${field ?? 'key'}`)?.focus()
      return
    }
    const key = v.key.trim().toUpperCase()
    create
      .mutateAsync({ ...v, key, module_prefix: v.module_prefix.trim().toUpperCase(), module_name: v.module_name.trim(), title: v.title.trim() })
      .then((res) => {
        // show the new row at once (no "not found" flash before the refetch)
        qc.setQueryData<Feature[]>(['admin', 'features'], (old) => (old ? [...old, res.feature] : old))
        onNotice('admin.features.created', 'success', { key })
        onCreated(key)
      })
      .catch((err: unknown) => onNotice(configErrorKey(err), 'error'))
  }

  return (
    <section className="admin-card" aria-labelledby={`${id}-head`}>
      <div className="card-head">
        <h2 id={`${id}-head`}>{t('admin.features.createTitle')}</h2>
      </div>
      <p className="tab-note">{t('admin.features.pickHint')}</p>
      <form onSubmit={submit} noValidate className="feature-form">
        {(['key', 'module_prefix', 'module_name', 'title'] as const).map((k) => (
          <div className="field-row" key={k}>
            <label htmlFor={`${id}-${k}`}>{t(`admin.features.create.${k}`)}</label>
            <input id={`${id}-${k}`} value={v[k]} maxLength={k === 'title' ? 300 : k === 'module_name' ? 200 : 21} onChange={(e) => set(k, e.target.value)} aria-invalid={badField === k} aria-describedby={badField === k ? `${id}-err` : undefined} />
          </div>
        ))}
        <div className="field-row">
          <label htmlFor={`${id}-status`}>{t('admin.features.status')}</label>
          <select id={`${id}-status`} value={v.status} onChange={(e) => set('status', e.target.value)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`admin.features.statuses.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div id={`${id}-err`}>
          {problem && (
            <p key={tries} className="form-note error" role="alert">
              {t(problem)}
            </p>
          )}
        </div>
        <Button type="submit" variant="primary" aria-disabled={create.isPending} aria-busy={create.isPending}>
          {t('admin.features.createButton')}
        </Button>
      </form>
    </section>
  )
}
