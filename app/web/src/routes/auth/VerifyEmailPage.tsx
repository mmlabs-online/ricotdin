// Email verification (AUT-01, SEC-02, SEC-05): the link carries #token=…; it is read once and
// removed from the address bar. The person chooses their password here and only then is the token
// posted to /auth/verify-email (with the password): mail scanners that open links never verify an
// account, and a password chosen by whoever registered the address first never survives (SEC-05).
// Without a usable token: resend form.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../auth/AuthProvider'
import { publicAuthErrorKey } from '../../auth/authErrors'
import { forgetHashToken, readHashToken } from '../../auth/emailLink'
import { newPasswordError } from '../../auth/validate'
import { AuthLayout } from '../../components/AuthLayout'
import { Button } from '../../components/ui/Button'
import { useDocumentTitle } from '../../lib/useDocumentTitle'
import { EmailLinkForm } from './ResendForm'

export function VerifyEmailPage() {
  const { t } = useTranslation()
  useDocumentTitle('page.verifyEmail.title')
  const { session } = useAuth()
  const location = useLocation()
  const [token] = useState(() => readHashToken(location.hash))
  const started = useRef(false)
  const [state, setState] = useState<'confirm' | 'verifying' | 'verified' | 'error' | 'resend'>(token ? 'confirm' : 'resend')
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const email = (location.state as { email?: string } | null)?.email ?? ''

  useEffect(() => {
    if (location.hash) forgetHashToken()
  }, [location.hash])

  const errId = useId()
  const helpId = useId()
  const pwRef = useRef<HTMLInputElement>(null)
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!token || started.current) return
    const invalid = newPasswordError(password, repeat)
    if (invalid) {
      setFieldError(invalid)
      pwRef.current?.focus()
      return
    }
    started.current = true // the token is single use: never post it twice at once
    setFieldError(null)
    setState('verifying')
    session
      .publicAuth('/verify-email', { token, password })
      .then(() => setState('verified'))
      .catch((err: unknown) => {
        const key = publicAuthErrorKey(err, 'verify')
        if (key === 'auth.errors.invalidLink') {
          setErrorKey(key)
          setState('error')
          return
        }
        // refused password, rate limit, offline: the token was not used, so the form stays
        started.current = false
        setFieldError(key)
        setState('confirm')
        requestAnimationFrame(() => pwRef.current?.focus())
      })
  }

  if (state === 'confirm' || state === 'verifying') {
    const busy = state === 'verifying'
    return (
      <AuthLayout>
        <form className="auth-card" onSubmit={submit} noValidate>
          <h1>{t('page.verifyEmail.title')}</h1>
          <p>{t('auth.verify.confirmHelp')}</p>
          <label>
            {t('auth.reset.newPassword')}
            <input
              ref={pwRef}
              type="password"
              autoComplete="new-password"
              value={password}
              maxLength={1024}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={fieldError ? `${helpId} ${errId}` : helpId}
            />
          </label>
          <p id={helpId} className="field-help">
            {t('auth.register.passwordHelp')}
          </p>
          <label>
            {t('auth.register.confirm')}
            <input
              type="password"
              autoComplete="new-password"
              value={repeat}
              maxLength={1024}
              onChange={(e) => setRepeat(e.target.value)}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={fieldError ? errId : undefined}
            />
          </label>
          {fieldError && (
            <p id={errId} key={fieldError + password.length} className="auth-error" role="alert">
              {t(fieldError)}
            </p>
          )}
          <Button type="submit" variant="primary" className="full" disabled={busy} aria-busy={busy}>
            {t('auth.verify.confirm')}
          </Button>
        </form>
      </AuthLayout>
    )
  }
  return (
    <AuthLayout>
      <div className="auth-card">
        {/* the form is gone: the result's heading takes focus */}
        <h1 tabIndex={-1} ref={(el) => (started.current ? el?.focus() : undefined)}>
          {t('page.verifyEmail.title')}
        </h1>
        {state === 'verified' ? (
          <>
            <p role="status">{t('auth.verify.done')}</p>
            <Link className="button button-primary full" to="/sign-in">
              {t('auth.submit')}
            </Link>
          </>
        ) : (
          <>
            {errorKey && (
              <p className="auth-error" role="alert">
                {t(errorKey)}
              </p>
            )}
            <p>{t('auth.verify.resendHelp')}</p>
            <EmailLinkForm path="/resend-verification" initialEmail={email} submitKey="auth.verify.resend" />
            <small>
              <Link to="/sign-in">{t('auth.backToSignIn')}</Link>
            </small>
          </>
        )}
      </div>
    </AuthLayout>
  )
}
