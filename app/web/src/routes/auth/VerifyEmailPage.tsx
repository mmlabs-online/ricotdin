// Email verification (AUT-01, SEC-02): the link carries #token=…; it is read once, removed from
// the address bar, and posted to /auth/verify-email. Without a usable token: resend form.
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../auth/AuthProvider'
import { publicAuthErrorKey } from '../../auth/authErrors'
import { forgetHashToken, readHashToken } from '../../auth/emailLink'
import { AuthLayout } from '../../components/AuthLayout'
import { FullPageLoading } from '../../components/FullPageLoading'
import { useDocumentTitle } from '../../lib/useDocumentTitle'
import { EmailLinkForm } from './ResendForm'

export function VerifyEmailPage() {
  const { t } = useTranslation()
  useDocumentTitle('page.verifyEmail.title')
  const { session } = useAuth()
  const location = useLocation()
  const [token] = useState(() => readHashToken(location.hash))
  const started = useRef(false)
  const [state, setState] = useState<'verifying' | 'verified' | 'error' | 'resend'>(token ? 'verifying' : 'resend')
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const email = (location.state as { email?: string } | null)?.email ?? ''

  useEffect(() => {
    if (location.hash) forgetHashToken()
    if (!token || started.current) return
    started.current = true // the token is single use: never post it twice
    session
      .publicAuth('/verify-email', { token })
      .then(() => setState('verified'))
      .catch((err: unknown) => {
        setErrorKey(publicAuthErrorKey(err, 'verify'))
        setState('error')
      })
  }, [token, session, location.hash])

  if (state === 'verifying') return <FullPageLoading />
  return (
    <AuthLayout>
      <div className="auth-card">
        <h1>{t('page.verifyEmail.title')}</h1>
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
