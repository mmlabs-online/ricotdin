// Profile & preferences (ARC-13c, Make ProfileView): details + avatar, password, appearance,
// default AI model, and the remaining audio minutes / chat questions.
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Check, Moon, Sun } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  useChangePassword,
  usePreferences,
  useProfile,
  useUpdatePreferences,
  useUpdateProfile,
  useUploadAvatar,
  type Preferences,
  type Profile,
} from '../api/profile'
import { initials } from '../app/initials'
import { useApiUrl } from '../auth/AuthProvider'
import { normalizeUsername, validateUsername } from '../auth/validate'
import { FullPageLoading } from '../components/FullPageLoading'
import { Button } from '../components/ui/Button'
import { mediaSrc } from '../lib/meetings/detail'
import { modelValue, parseModelValue, passwordProblem, profileErrorKey, quotaParts } from '../lib/profile/profile'
import { displayText } from '../lib/text'
import { AVATAR_TYPES, uploadErrorKey } from '../lib/upload/upload'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { COLOR_THEMES } from '../theme/theme'
import { useTheme } from '../theme/ThemeProvider'

type Note = { key: string; ok: boolean } | null

/** A form's result line: success is a status, an error an alert, both kept in the DOM. */
function FormNote({ note, id }: { note: Note; id?: string }) {
  const { t } = useTranslation()
  return (
    <>
      <p className="sr-only" role="status">
        {note?.ok ? t(note.key) : ''}
      </p>
      <p id={id} className={note && !note.ok ? 'form-note error' : 'form-note'} role="alert">
        {note && !note.ok ? t(note.key) : ''}
      </p>
      {note?.ok && (
        <p className="form-note success" aria-hidden="true">
          {t(note.key)}
        </p>
      )}
    </>
  )
}

function Section({ title, body, children }: { title: string; body: string; children: ReactNode }) {
  const id = useId()
  return (
    <section className="settings-card" aria-labelledby={id}>
      <div className="section-title">
        <h2 id={id}>{title}</h2>
        <p>{body}</p>
      </div>
      {children}
    </section>
  )
}

export function ProfilePage() {
  const { t } = useTranslation()
  useDocumentTitle('page.profile.title')
  const profile = useProfile()
  if (profile.isPending) return <FullPageLoading />
  if (!profile.data) {
    return (
      <div className="narrow">
        <div className="empty-state">
          <h1>{t('detail.loadError')}</h1>
          <Button onClick={() => void profile.refetch()}>{t('common.tryAgain')}</Button>
        </div>
      </div>
    )
  }
  return (
    <div className="narrow">
      <div className="page-head">
        <div>
          <span className="eyebrow">{t('page.profile.eyebrow')}</span>
          <h1>{t('page.profile.title')}</h1>
          <p>{t('page.profile.subtitle')}</p>
        </div>
      </div>
      <DetailsSection profile={profile.data} />
      <PasswordSection />
      <AppearanceSection />
      <ModelSection />
      <UsageSection profile={profile.data} />
    </div>
  )
}

function DetailsSection({ profile }: { profile: Profile }) {
  const { t } = useTranslation()
  const apiUrl = useApiUrl()
  const update = useUpdateProfile()
  const avatar = useUploadAvatar()
  const [username, setUsername] = useState(profile.username ?? '')
  const [displayName, setDisplayName] = useState(profile.display_name ?? '')
  const [note, setNote] = useState<Note>(null)
  const [avatarNote, setAvatarNote] = useState<Note>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const ids = { user: useId(), name: useId(), email: useId(), err: useId() }
  const src = mediaSrc(apiUrl, profile.avatar_url)
  const usernameError = note && !note.ok && note.key.startsWith('auth.validation') ? note.key : null

  function save(e: FormEvent) {
    e.preventDefault()
    if (update.isPending) return
    const changes: { username?: string; display_name?: string | null } = {}
    const u = normalizeUsername(username)
    if (u !== (profile.username ?? '')) {
      const bad = validateUsername(u)
      if (bad) return setNote({ key: bad, ok: false })
      changes.username = u
    }
    const name = displayName.trim()
    if (name !== (profile.display_name ?? '')) changes.display_name = name || null
    if (Object.keys(changes).length === 0) return setNote({ key: 'profile.details.unchanged', ok: true })
    setNote(null)
    update
      .mutateAsync(changes)
      .then(() => setNote({ key: 'profile.details.saved', ok: true }))
      .catch((err: unknown) => setNote({ key: profileErrorKey('details', err), ok: false }))
  }

  function pick(file: File | undefined) {
    if (!file || avatar.isPending) return
    setAvatarNote(null)
    setProgress(0)
    avatar
      .mutateAsync({ file, onProgress: setProgress })
      .then(() => setAvatarNote({ key: 'profile.avatar.saved', ok: true }))
      .catch((err: unknown) => setAvatarNote({ key: uploadErrorKey(err), ok: false }))
      .finally(() => {
        setProgress(null)
        if (fileRef.current) fileRef.current.value = ''
      })
  }

  return (
    <Section title={t('profile.details.title')} body={t('profile.details.body')}>
      <div className="profile-line">
        {src ? (
          <img className="avatar large avatar-img" src={src} alt={t('profile.avatar.alt')} />
        ) : (
          <div className="avatar large" aria-hidden="true">
            {initials(profile.email ? { username: profile.username, email: profile.email } : null)}
          </div>
        )}
        <div className="avatar-actions">
          <input
            ref={fileRef}
            type="file"
            accept={AVATAR_TYPES.join(',')}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => pick(e.target.files?.[0])}
          />
          <Button onClick={() => fileRef.current?.click()} aria-disabled={avatar.isPending} aria-busy={avatar.isPending}>
            {avatar.isPending ? t('profile.avatar.uploading', { percent: Math.round((progress ?? 0) * 100) }) : t('profile.avatar.upload')}
          </Button>
          <small>{t('profile.avatar.hint')}</small>
          <FormNote note={avatarNote} />
        </div>
      </div>
      <form onSubmit={save} noValidate>
        <div className="field-row">
          <label htmlFor={ids.user}>{t('profile.details.username')}</label>
          <input
            id={ids.user}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            maxLength={30}
            aria-invalid={usernameError !== null}
            aria-describedby={usernameError ? ids.err : undefined}
          />
        </div>
        <div className="field-row">
          <label htmlFor={ids.name}>{t('profile.details.displayName')}</label>
          <input id={ids.name} value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" maxLength={100} />
        </div>
        <div className="field-row">
          <label htmlFor={ids.email}>{t('profile.details.email')}</label>
          <input id={ids.email} value={profile.email ?? ''} readOnly />
        </div>
        <FormNote note={note} id={ids.err} />
        <Button type="submit" variant="primary" aria-disabled={update.isPending} aria-busy={update.isPending}>
          {t('profile.details.save')}
        </Button>
      </form>
    </Section>
  )
}

function PasswordSection() {
  const { t } = useTranslation()
  const change = useChangePassword()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [note, setNote] = useState<Note>(null)
  const ids = { current: useId(), next: useId(), confirm: useId(), err: useId() }
  const invalid = note !== null && !note.ok

  function submit(e: FormEvent) {
    e.preventDefault()
    if (change.isPending) return
    const problem = passwordProblem(current, next, confirm)
    if (problem) return setNote({ key: problem, ok: false })
    setNote(null)
    change
      .mutateAsync({ current, next })
      .then(() => {
        setCurrent('')
        setNext('')
        setConfirm('')
        setNote({ key: 'profile.password.changed', ok: true })
      })
      .catch((err: unknown) => setNote({ key: profileErrorKey('password', err), ok: false }))
  }

  const describedBy = invalid ? ids.err : undefined
  return (
    <Section title={t('profile.password.title')} body={t('profile.password.body')}>
      <form onSubmit={submit} noValidate>
        <div className="field-row">
          <label htmlFor={ids.current}>{t('profile.password.current')}</label>
          <input id={ids.current} type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" aria-invalid={invalid} aria-describedby={describedBy} />
        </div>
        <div className="field-row">
          <label htmlFor={ids.next}>{t('profile.password.new')}</label>
          <input id={ids.next} type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" aria-invalid={invalid} aria-describedby={describedBy} />
        </div>
        <div className="field-row">
          <label htmlFor={ids.confirm}>{t('profile.password.confirm')}</label>
          <input id={ids.confirm} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" aria-invalid={invalid} aria-describedby={describedBy} />
        </div>
        <FormNote note={note} id={ids.err} />
        <Button type="submit" variant="primary" aria-disabled={change.isPending} aria-busy={change.isPending}>
          {t('profile.password.submit')}
        </Button>
      </form>
    </Section>
  )
}

function AppearanceSection() {
  const { t } = useTranslation()
  const { dark, setDark, colorTheme, setColorTheme } = useTheme()
  return (
    <Section title={t('profile.appearance.title')} body={t('profile.appearance.body')}>
      <div className="theme-grid" role="group" aria-label={t('profile.appearance.mode')}>
        <button type="button" className={!dark ? 'selected' : ''} aria-pressed={!dark} onClick={() => setDark(false)}>
          <Sun size={20} aria-hidden="true" />
          <strong>{t('profile.appearance.light')}</strong>
          <span>{t('profile.appearance.lightHint')}</span>
        </button>
        <button type="button" className={dark ? 'selected' : ''} aria-pressed={dark} onClick={() => setDark(true)}>
          <Moon size={20} aria-hidden="true" />
          <strong>{t('profile.appearance.dark')}</strong>
          <span>{t('profile.appearance.darkHint')}</span>
        </button>
      </div>
      <h3 className="subhead">{t('profile.appearance.color')}</h3>
      <div className="theme-choice-grid" role="group" aria-label={t('profile.appearance.color')}>
        {COLOR_THEMES.map((theme) => (
          <button type="button" key={theme} className={colorTheme === theme ? 'selected' : ''} aria-pressed={colorTheme === theme} onClick={() => setColorTheme(theme)}>
            <span className={`theme-preview preview-${theme}`} aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <strong>{t(`theme.${theme}`)}</strong>
            {colorTheme === theme && <Check size={16} aria-hidden="true" />}
          </button>
        ))}
      </div>
    </Section>
  )
}

function ModelSection() {
  const { t } = useTranslation()
  const prefs = usePreferences()
  return (
    <Section title={t('profile.model.title')} body={t('profile.model.body')}>
      {prefs.data ? (
        <ModelForm prefs={prefs.data} />
      ) : prefs.isError ? (
        <div>
          <p className="tab-note">{t('detail.loadError')}</p>
          <Button onClick={() => void prefs.refetch()}>{t('common.tryAgain')}</Button>
        </div>
      ) : (
        <p className="tab-note">{t('common.loading')}</p>
      )}
    </Section>
  )
}

function ModelForm({ prefs }: { prefs: Preferences }) {
  const { t } = useTranslation()
  const save = useUpdatePreferences()
  const saved = modelValue(prefs.provider, prefs.model)
  const allowed = prefs.allowedModels.map((m) => modelValue(m.provider, m.model))
  // a personal default the admin has since removed is not offered any more
  const [value, setValue] = useState(allowed.includes(saved) ? saved : '')
  const [note, setNote] = useState<Note>(null)
  const id = useId()

  function submit(e: FormEvent) {
    e.preventDefault()
    if (save.isPending) return
    setNote(null)
    save
      .mutateAsync(parseModelValue(value))
      .then(() => setNote({ key: 'profile.model.saved', ok: true }))
      .catch((err: unknown) => setNote({ key: profileErrorKey('model', err), ok: false }))
  }

  return (
    <form onSubmit={submit}>
      <div className="field-row">
        <label htmlFor={id}>{t('profile.model.label')}</label>
        <select id={id} value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">{t('profile.model.systemDefault')}</option>
          {prefs.allowedModels.map((m) => (
            <option key={modelValue(m.provider, m.model)} value={modelValue(m.provider, m.model)}>
              {displayText(m.label)}
            </option>
          ))}
        </select>
      </div>
      <FormNote note={note} />
      <Button type="submit" variant="primary" aria-disabled={save.isPending} aria-busy={save.isPending}>
        {t('profile.model.save')}
      </Button>
    </form>
  )
}

function UsageSection({ profile }: { profile: Profile }) {
  const { t } = useTranslation()
  const audio = quotaParts(profile.audio_seconds_remaining)
  const queries = Math.max(0, profile.agent_queries_remaining)
  return (
    <Section title={t('profile.usage.title')} body={t('profile.usage.body')}>
      <dl className="usage-list">
        <div>
          <dt>{t('profile.usage.audio')}</dt>
          <dd>{t('profile.usage.audioValue', { h: audio.hours, m: audio.minutes })}</dd>
        </div>
        <div>
          <dt>{t('profile.usage.questions')}</dt>
          <dd>{t('profile.usage.questionsValue', { count: queries })}</dd>
        </div>
        <div>
          <dt>{t('profile.usage.meetings')}</dt>
          <dd>{profile.meeting_count}</dd>
        </div>
        <div>
          <dt>{t('profile.usage.folders')}</dt>
          <dd>{profile.folder_count}</dd>
        </div>
      </dl>
    </Section>
  )
}
