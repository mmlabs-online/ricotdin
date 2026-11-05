// Admin › Config (ARC-14c, Make ConfigAdmin): app settings (each saved on its own, every change
// asks first — the retention days delete audio on the worker's next run) and the AI model
// allow-list + system default.
import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppConfig, useGenerationConfig, useSaveConfig, useSaveGeneration, type ConfigRow, type GenerationConfig } from '../../api/admin/config'
import { AdminHead, NoticeBanner, useFormatters, useNotice } from '../../components/admin/AdminParts'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import { configKind, generationProblem, parseConfigInput, sameModel, type ModelPick } from '../../lib/admin/config'
import { configErrorKey } from '../../lib/admin/config'
import { adminErrorKey } from '../../lib/admin/users'
import { displayText } from '../../lib/text'
import { useDocumentTitle } from '../../lib/useDocumentTitle'

type Notify = (key: string | null, kind?: 'success' | 'warning' | 'error', values?: Record<string, unknown>) => void
const KNOWN = new Set(['storage.audio_retention_days', 'user_hack_audio_render'])

export function AdminConfigPage() {
  const { t } = useTranslation()
  useDocumentTitle('admin.tabs.config')
  const config = useAppConfig()
  const [notice, setNotice] = useNotice()
  return (
    <>
      <AdminHead titleKey="admin.tabs.config" subtitleKey="admin.config.subtitle" />
      <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} />
      <section className="admin-card" aria-labelledby="config-head">
        <div className="card-head">
          <h2 id="config-head">{t('admin.config.title')}</h2>
        </div>
        {config.isPending ? (
          <p className="tab-note">{t('common.loading')}</p>
        ) : !config.data ? (
          <div className="tab-note">
            <p>{t(adminErrorKey(config.error))}</p>
            <Button onClick={() => void config.refetch()}>{t('common.tryAgain')}</Button>
          </div>
        ) : config.data.length === 0 ? (
          <p className="tab-note">{t('admin.config.empty')}</p>
        ) : (
          <ul className="setting-list">
            {config.data.map((row) => (
              <SettingRow key={`${row.key}|${JSON.stringify(row.value)}`} row={row} onNotice={setNotice} />
            ))}
          </ul>
        )}
      </section>
      <ModelsCard onNotice={setNotice} />
    </>
  )
}

/** One setting. Remounted (key) when the stored value changes, so the field shows it. */
function SettingRow({ row, onNotice }: { row: ConfigRow; onNotice: Notify }) {
  const { t } = useTranslation()
  const f = useFormatters()
  const save = useSaveConfig()
  const kind = configKind(row.key, row.value)
  const [draft, setDraft] = useState(row.value === null || row.value === undefined ? '' : String(row.value))
  const [problem, setProblem] = useState<string | null>(null)
  const [tries, setTries] = useState(0)
  const [ask, setAsk] = useState<{ value: unknown } | null>(null)
  const ids = { input: useId(), err: useId(), body: useId(), desc: useId() }
  const known = KNOWN.has(row.key)
  const name = known ? t(`admin.config.keys.${row.key === 'user_hack_audio_render' ? 'hack' : 'retention'}.name`) : displayText(row.key)
  const help = known ? t(`admin.config.keys.${row.key === 'user_hack_audio_render' ? 'hack' : 'retention'}.help`) : row.description ? displayText(row.description) : null

  function submit(e: FormEvent) {
    e.preventDefault()
    if (save.isPending || kind === 'readonly' || kind === 'flag' || kind === 'bool') return
    const parsed = parseConfigInput(kind, draft)
    setTries((n) => n + 1)
    if ('error' in parsed) {
      setProblem(parsed.error)
      return
    }
    setProblem(null)
    if (parsed.value === row.value) return
    setAsk({ value: parsed.value })
  }

  function send() {
    if (!ask || save.isPending) return
    const value = ask.value
    setAsk(null)
    save
      .mutateAsync({ key: row.key, value })
      .then(() => onNotice('admin.config.saved', 'success', { name }))
      .catch((err: unknown) => onNotice(configErrorKey(err), 'error'))
  }

  const shown = (v: unknown) => (v === null || v === undefined || v === '' ? t('admin.config.none') : typeof v === 'boolean' ? t(v ? 'admin.config.on' : 'admin.config.off') : displayText(String(v)))

  return (
    <li className="setting-row">
      <div className="setting-text">
        <strong className="bidi-isolate">{name}</strong>
        {help && <p id={ids.desc}>{help}</p>}
        {row.updated_at && <small>{t('admin.config.updated', { time: f.dateTime(row.updated_at) })}</small>}
      </div>
      {kind === 'flag' || kind === 'bool' ? (
        <Button
          role="switch"
          aria-checked={row.value === true}
          aria-describedby={help ? ids.desc : undefined}
          className={row.value === true ? 'toggle-btn on' : 'toggle-btn'}
          onClick={() => !save.isPending && setAsk({ value: row.value !== true })}
          aria-disabled={save.isPending}
        >
          {t(row.value === true ? 'admin.config.on' : 'admin.config.off')}
        </Button>
      ) : kind === 'readonly' ? (
        <code className="log-meta">{displayText(JSON.stringify(row.value) ?? '')}</code>
      ) : (
        <form className="setting-form" onSubmit={submit} noValidate>
          <label htmlFor={ids.input} className="sr-only">
            {name}
          </label>
          <input
            id={ids.input}
            value={draft}
            inputMode={kind === 'string' ? 'text' : 'numeric'}
            placeholder={kind === 'retention' ? t('admin.config.keepForever') : undefined}
            onChange={(e) => setDraft(e.target.value)}
            aria-invalid={problem !== null}
            aria-describedby={[help ? ids.desc : '', problem ? ids.err : ''].filter(Boolean).join(' ') || undefined}
          />
          <Button type="submit" aria-disabled={save.isPending}>
            {t('admin.config.save')}
          </Button>
          <div id={ids.err} className="usage-error">
            {problem && (
              <p key={tries} className="form-note error" role="alert">
                {t(problem)}
              </p>
            )}
          </div>
        </form>
      )}
      {ask && (
        <Modal title={t('admin.config.confirmTitle', { name })} onClose={() => setAsk(null)} describedBy={ids.body}>
          <p className="modal-copy" id={ids.body}>
            {t('admin.config.confirmBody', { from: shown(row.value), to: shown(ask.value) })}
            {kind === 'retention' && ask.value !== null && ` ${t('admin.config.retentionWarning', { days: ask.value })}`}
          </p>
          <div className="modal-actions">
            <Button variant="ghost" onClick={() => setAsk(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant={kind === 'retention' && ask.value !== null ? 'danger' : 'primary'} onClick={send}>
              {t('admin.config.save')}
            </Button>
          </div>
        </Modal>
      )}
    </li>
  )
}

function ModelsCard({ onNotice }: { onNotice: Notify }) {
  const { t } = useTranslation()
  const gen = useGenerationConfig()
  return (
    <section className="admin-card" aria-labelledby="models-head">
      <div className="card-head">
        <h2 id="models-head">{t('admin.models.title')}</h2>
      </div>
      {gen.isPending ? (
        <p className="tab-note">{t('common.loading')}</p>
      ) : !gen.data ? (
        <p className="tab-note">{t(adminErrorKey(gen.error))}</p>
      ) : (
        <ModelsForm key={JSON.stringify([gen.data.allowedModels, gen.data.systemDefault])} data={gen.data} onNotice={onNotice} />
      )}
    </section>
  )
}

const pickId = (m: ModelPick) => `${m.provider}:${m.model}`

function ModelsForm({ data, onNotice }: { data: GenerationConfig; onNotice: Notify }) {
  const { t } = useTranslation()
  const save = useSaveGeneration()
  const [allowed, setAllowed] = useState<ModelPick[]>(data.allowedModels)
  const [def, setDef] = useState<ModelPick>(data.systemDefault)
  const [problem, setProblem] = useState<string | null>(null)
  const [tries, setTries] = useState(0)
  const [ask, setAsk] = useState(false)
  const ids = { def: useId(), err: useId(), body: useId(), legend: useId() }
  const label = (m: ModelPick) => displayText(data.registeredModels.find((r) => sameModel(r, m))?.label ?? pickId(m))
  const changed = pickId(def) !== pickId(data.systemDefault) || allowed.map(pickId).sort().join() !== data.allowedModels.map(pickId).sort().join()

  function toggle(m: ModelPick) {
    setAllowed((prev) => (prev.some((x) => sameModel(x, m)) ? prev.filter((x) => !sameModel(x, m)) : [...prev, m]))
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    if (save.isPending) return
    const p = generationProblem(allowed, def)
    setProblem(p)
    setTries((n) => n + 1)
    if (!p && changed) setAsk(true)
  }

  function send() {
    setAsk(false)
    if (save.isPending) return
    save
      .mutateAsync({ allowedModels: allowed, systemDefault: def })
      .then(() => onNotice('admin.models.saved'))
      .catch((err: unknown) => onNotice(configErrorKey(err), 'error'))
  }

  return (
    <form onSubmit={submit} noValidate className="models-form">
      <fieldset aria-describedby={problem ? ids.err : undefined}>
        <legend id={ids.legend}>{t('admin.models.allowed')}</legend>
        <ul className="model-list">
          {data.registeredModels.map((m) => (
            <li key={pickId(m)}>
              <label>
                <input type="checkbox" checked={allowed.some((x) => sameModel(x, m))} onChange={() => toggle(m)} /> {displayText(m.label)}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <div className="field-row">
        <label htmlFor={ids.def}>{t('admin.models.default')}</label>
        <select id={ids.def} value={pickId(def)} onChange={(e) => setDef(data.registeredModels.find((m) => pickId(m) === e.target.value) ?? def)} aria-invalid={problem === 'admin.models.errors.default'}>
          {data.registeredModels.map((m) => (
            <option key={pickId(m)} value={pickId(m)}>
              {displayText(m.label)}
            </option>
          ))}
        </select>
      </div>
      <div id={ids.err}>
        {problem && (
          <p key={tries} className="form-note error" role="alert">
            {t(problem)}
          </p>
        )}
      </div>
      <p className="tab-note">{t('admin.models.help')}</p>
      <Button type="submit" variant="primary" aria-disabled={save.isPending || !changed}>
        {t('admin.models.save')}
      </Button>
      {ask && (
        <Modal title={t('admin.models.confirmTitle')} onClose={() => setAsk(false)} describedBy={ids.body}>
          <div className="modal-copy" id={ids.body}>
            <p>{t('admin.models.confirmDefault', { model: label(def) })}</p>
            <p>{t('admin.models.confirmAllowed', { models: allowed.map(label).join(', ') })}</p>
          </div>
          <div className="modal-actions">
            <Button variant="ghost" onClick={() => setAsk(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={send}>
              {t('admin.models.save')}
            </Button>
          </div>
        </Modal>
      )}
    </form>
  )
}
