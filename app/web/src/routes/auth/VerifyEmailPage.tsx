// Email verification (AUT-01, SEC-02): the link carries #token=…; it is read once and removed
// from the address bar. It is posted to /auth/verify-email only when the person clicks "Confirm":
// mail scanners that open links and run the page must not verify an account on their own (with
// the §0.3 pre-registration risk, that would verify an attacker's account for the victim's
// address). Without a usable token: resend form.
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../auth/AuthProvider'
import { publicAuthErrorKey } from '../../auth/authErrors'
import { forgetHashToken, readHashToken } from '../../auth/emailLink'
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

  const confirm = () => {
    if (!token || started.current) return
    started.current = true // the token is single use: never post it twice
    setState('verifying')
    session
      .publicAuth('/verify-email', { token })
      .then(() => setState('verified'))
      .catch((err: unknown) => {
        setErrorKey(publicAuthErrorKey(err, 'verify'))
        setState('error')
      })
  }

  if (state === 'confirm' || state === 'verifying') {
    return (
      <AuthLayout>
        <div className="auth-card">
          <h1>{t('page.verifyEmail.title')}</h1>
          <p>{t('auth.verify.confirmHelp')}</p>
          <Button variant="primary" className="full" onClick={confirm} disabled={state === 'verifying'} aria-busy={state === 'verifying'}>
            {t('auth.verify.confirm')}
          </Button>
        </div>
      </AuthLayout>
    )
  }
  return (
    <AuthLayout>
      <div className="auth-card">
        {/* the Confirm button is gone: the result's heading takes focus */}
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
