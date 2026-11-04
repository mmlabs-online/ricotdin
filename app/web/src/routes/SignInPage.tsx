import { useId, useRef, useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Languages } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { safeReturnTo } from '../auth/guards'
import { signInErrorKey } from '../auth/signInErrors'
import { FullPageLoading } from '../components/FullPageLoading'
import { Logo } from '../components/Logo'
import { Button } from '../components/ui/Button'
import { setLocale } from '../i18n'
import { useDocumentTitle } from '../lib/useDocumentTitle'

export function SignInPage() {
  const { t, i18n } = useTranslation()
  const { state, session } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const signOutFailed = (useLocation().state as { signOutFailed?: boolean } | null)?.signOutFailed === true
  const next = safeReturnTo(params.get('next'))
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const errorId = useId()
  const [attempt, setAttempt] = useState(0)
  const [invalid, setInvalid] = useState({ identifier: false, password: false })
  const identifierRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  useDocumentTitle('auth.submit')
  const language = i18n.resolvedLanguage === 'vi' ? 'vi' : 'en'

  if (state.status === 'loading') return <FullPageLoading />
  // 'unavailable': the form still works; a failed sign-in shows the network/generic error
  if (state.status === 'signedIn' && !busy) return <Navigate to={next} replace />

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setAttempt((n) => n + 1) // re-announce a repeated identical error
    if (!identifier.trim() || !password) {
      setErrorKey('auth.errors.missing')
      setInvalid({ identifier: !identifier.trim(), password: !password })
      ;(identifier.trim() ? passwordRef : identifierRef).current?.focus()
      return
    }
    setBusy(true)
    setErrorKey(null)
    try {
      await session.signIn(identifier.trim(), password)
      navigate(next, { replace: true })
    } catch (err) {
      setErrorKey(signInErrorKey(err))
      setInvalid({ identifier: true, password: true })
      setPassword('')
      // the submit button was disabled while busy: put focus back where the user retries
      requestAnimationFrame(() => passwordRef.current?.focus())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-page">
      <header className="auth-top">
        <div className="brand">
          <Logo />
          <span>{t('app.name')}</span>
        </div>
        <div className="language-switch" role="group" aria-label={t('language.label')}>
          <Languages size={15} aria-hidden="true" />
          <button type="button" className={language === 'en' ? 'active' : ''} aria-pressed={language === 'en'} lang="en" onClick={() => setLocale('en')}>
            {t('language.en')}
          </button>
          <button type="button" className={language === 'vi' ? 'active' : ''} aria-pressed={language === 'vi'} lang="vi" onClick={() => setLocale('vi')}>
            {t('language.vi')}
          </button>
        </div>
      </header>
      <main>
        <form className="auth-card" onSubmit={(e) => void submit(e)} noValidate>
          <span className="eyebrow">{t('auth.welcome')}</span>
          <h1>{t('auth.title')}</h1>
          <p>{t('auth.subtitle')}</p>
          {signOutFailed && (
            <p className="auth-error" role="alert">
              {t('auth.signOutFailed')}
            </p>
          )}
          <label>
            {t('auth.identifier')}
            <input
              ref={identifierRef}
              name="identifier"
              autoComplete="username"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder={t('auth.identifierPlaceholder')}
              aria-invalid={errorKey !== null && invalid.identifier}
              aria-describedby={errorKey ? errorId : undefined}
              maxLength={320}
              autoFocus
            />
          </label>
          <label>
            {t('auth.password')}
            <input
              ref={passwordRef}
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('auth.passwordPlaceholder')}
              aria-invalid={errorKey !== null && invalid.password}
              aria-describedby={errorKey ? errorId : undefined}
              maxLength={1024}
            />
          </label>
          <button type="button" className="forgot" disabled title={t('auth.comingSoon')}>
            {t('auth.forgot')}
          </button>
          {errorKey && (
            <p key={attempt} id={errorId} className="auth-error" role="alert">
              {t(errorKey)}
            </p>
          )}
          <Button type="submit" variant="primary" className="full" disabled={busy} aria-busy={busy}>
            {busy ? t('auth.submitting') : t('auth.submit')}
          </Button>
          <small>
            {t('auth.newHere')}{' '}
            <button type="button" disabled title={t('auth.comingSoon')}>
              {t('auth.createAccount')}
            </button>
          </small>
        </form>
      </main>
    </div>
  )
}
