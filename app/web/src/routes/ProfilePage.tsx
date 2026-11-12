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
import { useFolders, type Folder } from '../api/meetings'
import { initials } from '../app/initials'
import { useApiUrl } from '../auth/AuthProvider'
import { normalizeUsername, validateUsername } from '../auth/validate'
import { FullPageLoading } from '../components/FullPageLoading'
import { Button } from '../components/ui/Button'
import { assignableFolders, defaultFolderLost, initialFolderChoice } from '../lib/folders/defaultFolder'
import { mediaSrc } from '../lib/meetings/detail'
import { modelValue, parseModelValue, passwordField, passwordProblem, profileErrorKey, quotaParts } from '../lib/profile/profile'
import { displayText } from '../lib/text'
import { AVATAR_TYPES, uploadErrorKey } from '../lib/upload/upload'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { COLOR_THEMES } from '../theme/theme'
import { useTheme } from '../theme/ThemeProvider'

type Note = { key: string; ok: boolean; n: number } | null

/** A note setter that makes even the same message a new node, so it is announced again (4.1.3). */
function useNote(): [Note, (key: string | null, ok?: boolean) => void] {
  const [note, setNote] = useState<Note>(null)
  const set = (key: string | null, ok = false) => setNote((prev) => (key ? { key, ok, n: (prev?.n ?? 0) + 1 } : null))
  return [note, set]
}

/** A form's result line: success is a status, an error an alert, both kept in the DOM. */
function FormNote({ note, id }: { note: Note; id?: string }) {
  const { t } = useTranslation()
  return (
    <>
      <p className="sr-only" role="status">
        {note?.ok ? t(note.key) : ''}
      </p>
      <p key={note?.n ?? 0} id={id} className={note && !note.ok ? 'form-note error' : 'form-note'} role="alert">
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
      <DefaultFolderSection />
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
  const [note, setNote] = useNote()
  const [avatarNote, setAvatarNote] = useNote()
  const [progress, setProgress] = useState<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const ids = { user: useId(), name: useId(), email: useId(), err: useId(), hint: useId(), avatarErr: useId() }
  const src = mediaSrc(apiUrl, profile.avatar_url)
  const usernameError =
    note && !note.ok && (note.key.startsWith('auth.validation') || note.key === 'profile.errors.usernameTaken' || note.key === 'profile.errors.invalid')
      ? note.key
      : null

  function save(e: FormEvent) {
    e.preventDefault()
    if (update.isPending) return
    const changes: { username?: string; display_name?: string | null } = {}
    const u = normalizeUsername(username)
    if (u !== (profile.username ?? '')) {
      const bad = validateUsername(u)
      if (bad) return setNote(bad)
      changes.username = u
    }
    const name = displayName.trim()
    if (name !== (profile.display_name ?? '')) changes.display_name = name || null
    if (Object.keys(changes).length === 0) return setNote('profile.details.unchanged', true)
    setNote(null)
    update
      .mutateAsync(changes)
      .then(() => setNote('profile.details.saved', true))
      .catch((err: unknown) => setNote(profileErrorKey('details', err)))
  }

  function pick(file: File | undefined) {
    if (!file || avatar.isPending) return
    setAvatarNote(null)
    setProgress(0)
    avatar
      .mutateAsync({ file, onProgress: setProgress })
      .then(() => setAvatarNote('profile.avatar.saved', true))
      .catch((err: unknown) => setAvatarNote(uploadErrorKey(err)))
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
          <Button
            onClick={() => !avatar.isPending && fileRef.current?.click()}
            aria-disabled={avatar.isPending}
            aria-busy={avatar.isPending}
            aria-describedby={avatarNote && !avatarNote.ok ? `${ids.hint} ${ids.avatarErr}` : ids.hint}
          >
            {avatar.isPending ? t('profile.avatar.uploading', { percent: Math.round((progress ?? 0) * 100) }) : t('profile.avatar.upload')}
          </Button>
          <small id={ids.hint}>{t('profile.avatar.hint')}</small>
          <FormNote note={avatarNote} id={ids.avatarErr} />
        </div>
      </div>
      <form onSubmit={save} noValidate>
        <div className="field-row">
          <label htmlFor={ids.user}>{t('profile.details.username')}</label>
          <input
            id={ids.user}
            value={username}
            onChange={(e) => {
              setUsername(e.target.value)
              setNote(null)
            }}
            autoComplete="username"
            maxLength={30}
            aria-invalid={usernameError !== null}
            aria-describedby={usernameError ? ids.err : undefined}
          />
        </div>
        <div className="field-row">
          <label htmlFor={ids.name}>{t('profile.details.displayName')}</label>
          <input
            id={ids.name}
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value)
              setNote(null)
            }} autoComplete="name" maxLength={100} />
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
  const [note, setNote] = useNote()
  const ids = { current: useId(), next: useId(), confirm: useId(), err: useId() }
  const field = note && !note.ok ? passwordField(note.key) : null

  function submit(e: FormEvent) {
    e.preventDefault()
    if (change.isPending) return
    const problem = passwordProblem(current, next, confirm)
    if (problem) return setNote(problem)
    setNote(null)
    change
      .mutateAsync({ current, next })
      .then(() => {
        setCurrent('')
        setNext('')
        setConfirm('')
        setNote('profile.password.changed', true)
      })
      .catch((err: unknown) => setNote(profileErrorKey('password', err)))
  }

  const mark = (f: 'current' | 'next' | 'confirm') => ({
    'aria-invalid': field === f,
    'aria-describedby': field === f ? ids.err : undefined,
  })
  const edit = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value)
    if (note?.ok) setNote(null)
  }
  return (
    <Section title={t('profile.password.title')} body={t('profile.password.body')}>
      <form onSubmit={submit} noValidate>
        <div className="field-row">
          <label htmlFor={ids.current}>{t('profile.password.current')}</label>
          <input id={ids.current} type="password" value={current} onChange={edit(setCurrent)} autoComplete="current-password" {...mark('current')} />
        </div>
        <div className="field-row">
          <label htmlFor={ids.next}>{t('profile.password.new')}</label>
          <input id={ids.next} type="password" value={next} onChange={edit(setNext)} autoComplete="new-password" {...mark('next')} />
        </div>
        <div className="field-row">
          <label htmlFor={ids.confirm}>{t('profile.password.confirm')}</label>
          <input id={ids.confirm} type="password" value={confirm} onChange={edit(setConfirm)} autoComplete="new-password" {...mark('confirm')} />
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
          {!dark && <Check size={16} aria-hidden="true" className="mode-check" />}
        </button>
        <button type="button" className={dark ? 'selected' : ''} aria-pressed={dark} onClick={() => setDark(true)}>
          <Moon size={20} aria-hidden="true" />
          <strong>{t('profile.appearance.dark')}</strong>
          <span>{t('profile.appearance.darkHint')}</span>
          {dark && <Check size={16} aria-hidden="true" className="mode-check" />}
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
  const [note, setNote] = useNote()
  const id = useId()

  function submit(e: FormEvent) {
    e.preventDefault()
    if (save.isPending) return
    setNote(null)
    save
      .mutateAsync(parseModelValue(value))
      .then(() => setNote('profile.model.saved', true))
      .catch((err: unknown) => setNote(profileErrorKey('model', err)))
  }

  return (
    <form onSubmit={submit}>
      <div className="field-row">
        <label htmlFor={id}>{t('profile.model.label')}</label>
        <select
          id={id}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setNote(null)
          }}
        >
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

function DefaultFolderSection() {
  const { t } = useTranslation()
  const prefs = usePreferences()
  const folders = useFolders()
  const failed = prefs.isError || folders.isError
  return (
    <Section title={t('profile.folder.title')} body={t('profile.folder.body')}>
      {prefs.data && folders.data ? (
        <DefaultFolderForm saved={prefs.data.defaultFolderId} folders={folders.data} onStale={() => void folders.refetch()} />
      ) : failed ? (
        <div>
          <p className="tab-note">{t('detail.loadError')}</p>
          <Button
            onClick={() => {
              if (prefs.isError) void prefs.refetch()
              if (folders.isError) void folders.refetch()
            }}
          >
            {t('common.tryAgain')}
          </Button>
        </div>
      ) : (
        <p className="tab-note">{t('common.loading')}</p>
      )}
    </Section>
  )
}

function DefaultFolderForm({
  saved,
  folders,
  onStale,
}: {
  saved: string | null
  folders: Folder[]
  onStale: () => void
}) {
  const { t } = useTranslation()
  const save = useUpdatePreferences()
  const targets = assignableFolders(folders)
  // a default the user can no longer add meetings to is shown as "No folder"
  const [value, setValue] = useState(initialFolderChoice(saved, folders) ?? '')
  const [note, setNote] = useNote()
  const id = useId()
  const lostId = useId()
  const lost = value === '' && defaultFolderLost(saved, folders)

  function submit(e: FormEvent) {
    e.preventDefault()
    if (save.isPending) return
    setNote(null)
    save
      .mutateAsync({ defaultFolderId: value || null })
      .then(() => setNote('profile.folder.saved', true))
      .catch((err: unknown) => {
        const key = profileErrorKey('folder', err)
        if (key === 'profile.errors.folderUnavailable') onStale() // drop the gone folder from the list
        setNote(key)
      })
  }

  return (
    <form onSubmit={submit}>
      <div className="field-row">
        <label htmlFor={id}>{t('profile.folder.label')}</label>
        <select
          id={id}
          value={value}
          aria-describedby={lost ? lostId : undefined}
          onChange={(e) => {
            setValue(e.target.value)
            setNote(null)
          }}
        >
          <option value="">{t('meetings.folders.none')}</option>
          {targets.map((f) => (
            <option key={f.id} value={f.id}>
              {f.myRole === 'owner' ? displayText(f.name) : `${displayText(f.name)} ${t('meetings.folders.sharedSuffix')}`}
            </option>
          ))}
        </select>
      </div>
      {lost && (
        <p id={lostId} className="tab-note">
          {t('profile.folder.lost')}
        </p>
      )}
      <FormNote note={note} />
      <Button type="submit" variant="primary" aria-disabled={save.isPending} aria-busy={save.isPending}>
        {t('profile.folder.save')}
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
