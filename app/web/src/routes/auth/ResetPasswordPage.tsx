// AUT-02: set a new password from the emailed link (#token=…). Every session is signed out.
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

export function ResetPasswordPage() {
  const { t } = useTranslation()
  useDocumentTitle('page.resetPassword.title')
  const { session } = useAuth()
  const location = useLocation()
  const [token] = useState(() => readHashToken(location.hash))
  const errId = useId()
  const helpId = useId()
  const pwRef = useRef<HTMLInputElement>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (location.hash) forgetHashToken()
  }, [location.hash])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!token || busy) return
    const invalid = newPasswordError(password, confirm)
    if (invalid) {
      setErrorKey(invalid)
      pwRef.current?.focus()
      return
    }
    setBusy(true)
    setErrorKey(null)
    try {
      await session.publicAuth('/reset-password', { token, password })
      setDone(true)
    } catch (err) {
      setErrorKey(publicAuthErrorKey(err, 'reset'))
      requestAnimationFrame(() => pwRef.current?.focus())
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout>
      {done ? (
        <div className="auth-card" role="status">
          <h1 tabIndex={-1} ref={(el) => el?.focus()}>
            {t('page.resetPassword.title')}
          </h1>
          <p>{t('auth.reset.done')}</p>
          <Link className="button button-primary full" to="/sign-in">
            {t('auth.submit')}
          </Link>
        </div>
      ) : !token ? (
        <div className="auth-card">
          <h1>{t('page.resetPassword.title')}</h1>
          <p className="auth-error" role="alert">
            {t('auth.errors.invalidLink')}
          </p>
          <Link className="button button-primary full" to="/forgot-password">
            {t('auth.reset.newLink')}
          </Link>
        </div>
      ) : (
        <form className="auth-card" onSubmit={(e) => void submit(e)} noValidate>
          <h1>{t('page.resetPassword.title')}</h1>
          <p>{t('auth.reset.help')}</p>
          <label>
            {t('auth.reset.newPassword')}
            <input
              ref={pwRef}
              type="password"
              autoComplete="new-password"
              value={password}
              maxLength={1024}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={errorKey ? true : undefined}
              aria-describedby={errorKey ? `${helpId} ${errId}` : helpId}
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
              value={confirm}
              maxLength={1024}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={errorKey ? true : undefined}
              aria-describedby={errorKey ? errId : undefined}
            />
          </label>
          {errorKey && (
            <p id={errId} className="auth-error" role="alert">
              {t(errorKey)}
              {errorKey === 'auth.errors.invalidLink' && (
                <>
                  {' '}
                  <Link to="/forgot-password">{t('auth.reset.newLink')}</Link>
                </>
              )}
            </p>
          )}
          <Button type="submit" variant="primary" className="full" disabled={busy} aria-busy={busy}>
            {t('auth.reset.submit')}
          </Button>
        </form>
      )}
    </AuthLayout>
  )
}
