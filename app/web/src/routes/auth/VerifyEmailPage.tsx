// Email verification for the mmlabs account (AUT-05). The link carries #token=…; it is read once
// and removed from the address bar, and only posted after the person clicks (mail scanners that
// open links do not verify). Without a usable token: sign in, and ricotdin offers a new email.
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../auth/AuthProvider'
import { publicAuthErrorKey } from '../../auth/authErrors'
import { forgetHashToken, readHashToken } from '../../auth/emailLink'
import { AuthLayout } from '../../components/AuthLayout'
import { Button } from '../../components/ui/Button'
import { useDocumentTitle } from '../../lib/useDocumentTitle'

export function VerifyEmailPage() {
  const { t } = useTranslation()
  useDocumentTitle('page.verifyEmail.title')
  const { session } = useAuth()
  const location = useLocation()
  const [token] = useState(() => readHashToken(location.hash))
  const started = useRef(false)
  const [state, setState] = useState<'confirm' | 'verifying' | 'verified' | 'error' | 'noToken'>(token ? 'confirm' : 'noToken')
  const [errorKey, setErrorKey] = useState<string | null>(null)

  useEffect(() => {
    if (location.hash) forgetHashToken()
  }, [location.hash])

  const verify = () => {
    if (!token || started.current) return
    started.current = true // the token is single use: never post it twice at once
    setState('verifying')
    session
      .publicAuth('/verify-email', { token })
      .then(async () => {
        setState('verified')
        // signed in on this browser and waiting for the email: continue straight away
        if (session.getState().status === 'actionRequired') await session.refresh().catch(() => false)
      })
      .catch((err: unknown) => {
        const key = publicAuthErrorKey(err, 'verify')
        if (key !== 'auth.errors.invalidLink') started.current = false // not used: may retry
        setErrorKey(key)
        setState(key === 'auth.errors.invalidLink' ? 'error' : 'confirm')
      })
  }

  return (
    <AuthLayout>
      <div className="auth-card">
        <h1 tabIndex={-1} ref={(el) => (started.current ? el?.focus() : undefined)}>
          {t('page.verifyEmail.title')}
        </h1>
        {state === 'confirm' || state === 'verifying' ? (
          <>
            <p>{t('auth.verify.clickHelp')}</p>
            {errorKey && (
              <p className="auth-error" role="alert">
                {t(errorKey)}
              </p>
            )}
            <Button variant="primary" className="full" aria-disabled={state === 'verifying' || undefined} aria-busy={state === 'verifying'} onClick={verify}>
              {t('auth.verify.button')}
            </Button>
          </>
        ) : state === 'verified' ? (
          <>
            <p role="status">{t('auth.verify.doneMmlabs')}</p>
            <Link className="button button-primary full" to="/sign-in">
              {t('auth.verify.continue')}
            </Link>
          </>
        ) : (
          <>
            {errorKey && (
              <p className="auth-error" role="alert">
                {t(errorKey)}
              </p>
            )}
            <p>{t('auth.verify.resendSignIn')}</p>
            <Link className="button button-primary full" to="/sign-in">
              {t('auth.submit')}
            </Link>
          </>
        )}
      </div>
    </AuthLayout>
  )
}
