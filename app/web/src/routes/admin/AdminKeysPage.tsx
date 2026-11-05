// Admin › API keys (ARC-14c, Make KeysAdmin): provider keys, write-only. A saved key never comes
// back (label + last 4 only); enable / disable / delete ask first; the API keeps the last active key
// of a provider (422 → "refused").
import { useId, useRef, useState, type FormEvent } from 'react'
import { ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useKeyMutations, useKeys, useLastKeyCheck, type KeyRow } from '../../api/admin/config'
import { AdminHead, NoticeBanner, useFormatters, useNotice } from '../../components/admin/AdminParts'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import { Status } from '../../components/ui/Status'
import { configErrorKey, healthStatusKind, keyGroups, keyProblem } from '../../lib/admin/config'
import { ApiError } from '../../api/errors'
import { displayText } from '../../lib/text'
import { useDocumentTitle } from '../../lib/useDocumentTitle'

/** 422 on disable / delete = the provider's last active key (the API keeps one). */
const keyErrorKey = (err: unknown) => (err instanceof ApiError && err.status === 422 ? 'admin.keys.errors.lastActive' : configErrorKey(err))
const providerOf = (configKey: string) => configKey.replace(/_api_key$/, '')

const KNOWN_NAMES = new Set(['gemini', 'openai', 'grok', 'speechmatics'])
function useProviderName() {
  const { t } = useTranslation()
  // a provider added to the API catalog later shows under its own name until it gets a label
  return (p: string) => (KNOWN_NAMES.has(p) ? t(`admin.usage.provider.${p}`) : displayText(p))
}

type Ask = { kind: 'disable' | 'enable' | 'delete'; row: KeyRow }

export function AdminKeysPage() {
  const { t } = useTranslation()
  useDocumentTitle('admin.tabs.keys')
  const keys = useKeys()
  const last = useLastKeyCheck()
  const m = useKeyMutations()
  const f = useFormatters()
  const [notice, setNotice] = useNotice()
  const [ask, setAsk] = useState<Ask | null>(null)
  const [reason, setReason] = useState('')
  const ids = { body: useId(), reason: useId() }
  const busy = m.status.isPending || m.remove.isPending

  const groups = keyGroups(keys.data ?? [])
  const byProvider = (p: string) => (keys.data ?? []).filter((k) => k.config_key === `${p}_api_key`)
  const name = useProviderName()

  function run() {
    if (!ask || busy) return
    const { kind, row } = ask
    setAsk(null)
    const opener = `[data-key-row="${row.id}"]`
    const call =
      kind === 'delete'
        ? m.remove.mutateAsync(row.id)
        : m.status.mutateAsync({ id: row.id, status: kind === 'disable' ? 'disabled' : 'active', ...(kind === 'disable' && reason.trim() ? { disabled_reason: reason.trim() } : {}) })
    call
      .then(() => {
        setNotice(`admin.keys.done.${kind}`)
        // enable / disable: the same button stays (its label flips); a deleted row is gone, so focus
        // its provider's heading (stable, tabIndex -1)
        requestAnimationFrame(() =>
          (kind === 'delete' ? document.getElementById(`keys-${providerOf(row.config_key)}`) : document.querySelector<HTMLElement>(`${opener} button`))?.focus(),
        )
      })
      .catch((err: unknown) => setNotice(keyErrorKey(err), 'error'))
  }

  function runCheck() {
    if (m.check.isPending) return
    m.check
      .mutateAsync()
      .then((r) => setNotice('admin.keys.checked', 'success', { healthy: r.summary.healthy ?? 0, unhealthy: r.summary.unhealthy ?? 0, unknown: r.summary.unknown ?? 0 }))
      .catch((err: unknown) => setNotice(configErrorKey(err), 'error'))
  }

  return (
    <>
      <AdminHead titleKey="admin.tabs.keys" subtitleKey="admin.keys.subtitle" />
      <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} />
      <div className="admin-toolbar">
        <span className="last-check">{last.data ? t('admin.keys.lastCheck', { time: f.dateTime(last.data) }) : t('admin.keys.neverChecked')}</span>
        <Button onClick={runCheck} aria-disabled={m.check.isPending} aria-busy={m.check.isPending}>
          {t(m.check.isPending ? 'admin.keys.checking' : 'admin.keys.runCheck')}
        </Button>
      </div>

      {keys.isPending ? (
        <p className="tab-note">{t('common.loading')}</p>
      ) : !keys.data ? (
        <div className="tab-note">
          <p>{t(configErrorKey(keys.error))}</p>
          <Button onClick={() => void keys.refetch()}>{t('common.tryAgain')}</Button>
        </div>
      ) : (
        groups.map((p) => (
          <section className="admin-card provider-card" key={p} aria-labelledby={`keys-${p}`}>
            <div className="card-head">
              <h2 id={`keys-${p}`} tabIndex={-1}>
                {name(p)}
              </h2>
            </div>
            {byProvider(p).length === 0 ? (
              <p className="tab-note">{t('admin.keys.noKeys')}</p>
            ) : (
              <ul className="key-list">
                {byProvider(p).map((k) => (
                  <li className="key-item" key={k.id} data-key-row={k.id}>
                    <div className="key-name">
                      <strong className="bidi-isolate">{displayText(k.label)}</strong>
                      <small>
                        <span aria-hidden="true">{t('admin.keys.masked', { last4: displayText(k.last4) })}</span>
                        <span className="sr-only">{t('admin.keys.endingIn', { last4: displayText(k.last4) })}</span>
                      </small>
                    </div>
                    <div className="key-meta">
                      <Status type={k.status === 'active' ? 'success' : 'danger'}>
                        <span className="sr-only">{t('admin.keys.statusLabel')}</span>
                        {t(`admin.keys.status.${k.status}`)}
                      </Status>
                      <Status type={healthStatusKind(k.health_status)}>
                        <span className="sr-only">{t('admin.keys.healthLabel')}</span>
                        {t(`admin.keys.health.${k.health_status === 'healthy' || k.health_status === 'unhealthy' ? k.health_status : k.health_checked_at ? 'inconclusive' : 'unknown'}`)}
                      </Status>
                    </div>
                    <div className="key-detail">
                      <small>{k.last_used_at ? t('admin.keys.lastUsed', { time: f.dateTime(k.last_used_at) }) : t('admin.keys.neverUsed')}</small>
                      {k.health_checked_at && <small>{t('admin.keys.checkedAt', { time: f.dateTime(k.health_checked_at) })}</small>}
                      {k.status === 'disabled' && k.disabled_reason && <small className="bidi-isolate">{t('admin.keys.reason', { reason: displayText(k.disabled_reason) })}</small>}
                    </div>
                    <div className="key-actions">
                      <Button
                        onClick={() => {
                          setReason('')
                          if (!busy) setAsk({ kind: k.status === 'active' ? 'disable' : 'enable', row: k })
                        }}
                        aria-disabled={busy}
                        aria-label={t(k.status === 'active' ? 'admin.keys.disableOne' : 'admin.keys.enableOne', { label: displayText(k.label) })}
                      >
                        {t(k.status === 'active' ? 'admin.keys.disable' : 'admin.keys.enable')}
                      </Button>
                      <Button variant="ghost" onClick={() => !busy && setAsk({ kind: 'delete', row: k })} aria-disabled={busy} aria-label={t('admin.keys.deleteOne', { label: displayText(k.label) })}>
                        {t('admin.keys.delete')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))
      )}

      <AddKeyForm providers={groups} onNotice={setNotice} />

      <div className="secure-note">
        <ShieldCheck size={18} aria-hidden="true" />
        <div>
          <strong>{t('admin.keys.secureTitle')}</strong>
          <p>{t('admin.keys.secureBody')}</p>
        </div>
      </div>

      {ask && (
        <Modal title={t(`admin.keys.confirm.${ask.kind}.title`)} onClose={() => setAsk(null)} describedBy={ids.body}>
          <p className="modal-copy" id={ids.body}>
            {t(`admin.keys.confirm.${ask.kind}.body`, { label: displayText(ask.row.label), last4: displayText(ask.row.last4) })}
          </p>
          {ask.kind === 'disable' && (
            <div className="field-row">
              <label htmlFor={ids.reason}>{t('admin.keys.reasonLabel')}</label>
              <input id={ids.reason} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
            </div>
          )}
          <div className="modal-actions">
            <Button variant="ghost" onClick={() => setAsk(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant={ask.kind === 'enable' ? 'primary' : 'danger'} onClick={run}>
              {t(`admin.keys.${ask.kind}`)}
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
}

function AddKeyForm({ providers, onNotice }: { providers: string[]; onNotice: (key: string | null, kind?: 'success' | 'warning' | 'error') => void }) {
  const { t } = useTranslation()
  const { add } = useKeyMutations()
  const [provider, setProvider] = useState('gemini')
  const name = useProviderName()
  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [tries, setTries] = useState(0)
  const [saved, setSaved] = useState(false)
  const keyRef = useRef<HTMLInputElement>(null)
  const labelRef = useRef<HTMLInputElement>(null)
  const ids = { provider: useId(), label: useId(), key: useId(), note: useId(), head: useId() }
  const labelBad = problem === 'admin.keys.errors.label' || problem === 'admin.keys.errors.labelLong'

  function submit(e: FormEvent) {
    e.preventDefault()
    if (add.isPending) return
    const p = keyProblem({ label, key })
    setProblem(p)
    setSaved(false)
    setTries((n) => n + 1)
    if (p) {
      ;(p.startsWith('admin.keys.errors.label') ? labelRef : keyRef).current?.focus()
      return
    }
    add
      .mutateAsync({ configKey: `${provider}_api_key`, label: label.trim(), key: key.trim() })
      .then(() => {
        setKey('') // the secret leaves the page at once (field + mutation state)
        add.reset()
        setLabel('')
        setSaved(true)
        setTries((n) => n + 1)
        onNotice('admin.keys.saved')
      })
      .catch((err: unknown) => {
        setKey('')
        add.reset()
        onNotice(err instanceof ApiError && err.status === 503 ? 'admin.keys.errors.noSecret' : configErrorKey(err), 'error')
      })
  }

  return (
    <section className="admin-card" aria-labelledby={ids.head}>
      <div className="card-head">
        <h2 id={ids.head}>{t('admin.keys.addTitle')}</h2>
      </div>
      <form className="grant-form" onSubmit={submit} noValidate autoComplete="off">
        <div className="field-row">
          <label htmlFor={ids.provider}>{t('admin.keys.provider')}</label>
          <select id={ids.provider} value={provider} onChange={(e) => setProvider(e.target.value)}>
            {providers.map((p) => (
              <option key={p} value={p}>
                {name(p)}
              </option>
            ))}
          </select>
        </div>
        <div className="field-row">
          <label htmlFor={ids.label}>{t('admin.keys.label')}</label>
          <input id={ids.label} ref={labelRef} value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} aria-invalid={labelBad} aria-describedby={labelBad ? ids.note : undefined} />
        </div>
        <div className="field-row">
          <label htmlFor={ids.key}>{t('admin.keys.key')}</label>
          <input
            id={ids.key}
            ref={keyRef}
            type="password"
            value={key}
            autoComplete="new-password"
            spellCheck={false}
            // not a site password: keep password managers from offering to save it
            data-1p-ignore=""
            data-lpignore="true"
            data-form-type="other"
            onChange={(e) => setKey(e.target.value)}
            aria-invalid={problem !== null && !labelBad}
            aria-describedby={problem !== null && !labelBad ? ids.note : undefined}
          />
        </div>
        <div id={ids.note}>
          {problem && (
            <p key={tries} className="form-note error" role="alert">
              {t(problem)}
            </p>
          )}
          {saved && (
            <p key={tries} className="form-note">
              {t('admin.keys.saved')}
            </p>
          )}
        </div>
        <Button type="submit" variant="primary" aria-disabled={add.isPending} aria-busy={add.isPending}>
          {t('admin.keys.add')}
        </Button>
      </form>
    </section>
  )
}
