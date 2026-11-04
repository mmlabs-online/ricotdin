import { useId, useRef, useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../auth/AuthProvider'
import { safeReturnTo } from '../auth/guards'
import { signInErrorKey } from '../auth/signInErrors'
import { FullPageLoading } from '../components/FullPageLoading'
import { AuthLayout } from '../components/AuthLayout'
import { Button } from '../components/ui/Button'
import { useDocumentTitle } from '../lib/useDocumentTitle'

export function SignInPage() {
  const { t } = useTranslation()
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
    <AuthLayout>
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
          <Link className="forgot" to="/forgot-password">
            {t('auth.forgot')}
          </Link>
          {errorKey && (
            <p key={attempt} id={errorId} className="auth-error" role="alert">
              {t(errorKey)}
              {errorKey === 'auth.errors.email_not_verified' && (
                <>
                  {' '}
                  <Link to="/verify-email" state={{ email: identifier.includes('@') ? identifier.trim() : '' }}>
                    {t('auth.resendLink')}
                  </Link>
                </>
              )}
            </p>
          )}
          <Button type="submit" variant="primary" className="full" disabled={busy} aria-busy={busy}>
            {busy ? t('auth.submitting') : t('auth.submit')}
          </Button>
          <small>
            {t('auth.newHere')}{' '}
            <Link to="/register">{t('auth.createAccount')}</Link>
          </small>
        </form>
    </AuthLayout>
  )
}
