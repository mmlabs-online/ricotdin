// Sign in with the mmlabs account (AUT-05): email + password at api.mmlabs.online, or "Continue
// as" an account already signed in on this browser (another mmlabs app). Joining ricotdin and
// verifying the email happen here too (AuthState `actionRequired`).
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { ApiError } from '../api/errors'
import { useAuth, useTurnstileSiteKey } from '../auth/AuthProvider'
import { safeReturnTo } from '../auth/guards'
import type { MmAccount } from '../auth/mmlabs'
import type { AuthState } from '../auth/session'
import { needsTurnstile, signInErrorKey } from '../auth/signInErrors'
import { normalizeEmail } from '../auth/validate'
import { FullPageLoading } from '../components/FullPageLoading'
import { AuthLayout } from '../components/AuthLayout'
import { Turnstile } from '../components/Turnstile'
import { Button } from '../components/ui/Button'
import { useDocumentTitle } from '../lib/useDocumentTitle'

export function SignInPage() {
  const { t } = useTranslation()
  const { state, session } = useAuth()
  const siteKey = useTurnstileSiteKey()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const location = useLocation()
  const navState = location.state as { signOutFailed?: boolean; accountDeleted?: boolean; deleteUncertain?: boolean } | null
  const signOutFailed = navState?.signOutFailed === true
  // PRF-13: shown once (kept in state), then dropped from history so a reload does not repeat it
  const [accountDeleted] = useState(navState?.accountDeleted === true)
  const [deleteUncertain] = useState(navState?.deleteUncertain === true)
  useEffect(() => {
    if (navState?.accountDeleted || navState?.deleteUncertain) void navigate(location.pathname + location.search, { replace: true, state: null })
  }, [navState, navigate, location.pathname, location.search])
  const next = safeReturnTo(params.get('next'))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [challenge, setChallenge] = useState(false)
  const [turnstile, setTurnstile] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  const [accounts, setAccounts] = useState<MmAccount[]>([])
  const errorId = useId()
  const [attempt, setAttempt] = useState(0)
  const [invalid, setInvalid] = useState({ email: false, password: false })
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  useDocumentTitle('auth.submit')

  const signedOut = state.status === 'signedOut' || state.status === 'unavailable'
  useEffect(() => {
    if (!signedOut) return
    let live = true
    void session.accounts().then((list) => live && setAccounts(list))
    return () => {
      live = false
    }
  }, [signedOut, session])

  if (state.status === 'loading') return <FullPageLoading />
  if (state.status === 'signedIn' && !busy) return <Navigate to={next} replace />
  if (state.status === 'actionRequired') return <PendingAction state={state} onDone={() => navigate(next, { replace: true })} />

  const finish = (result: AuthState) => {
    if (result.status === 'signedIn') navigate(next, { replace: true })
  }

  const fail = (err: unknown) => {
    setErrorKey(signInErrorKey(err))
    if (needsTurnstile(err)) setChallenge(true)
    setRound((n) => n + 1) // a Turnstile token is single use
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setAttempt((n) => n + 1) // re-announce a repeated identical error
    const value = normalizeEmail(email)
    if (!value || !password) {
      setErrorKey('auth.errors.missing')
      setInvalid({ email: !value, password: !password })
      ;(value ? passwordRef : emailRef).current?.focus()
      return
    }
    if (challenge && !turnstile) {
      setErrorKey('auth.errors.turnstile_required')
      return
    }
    setBusy(true)
    setErrorKey(null)
    try {
      finish(await session.signIn(value, password, challenge ? (turnstile ?? undefined) : undefined))
    } catch (err) {
      fail(err)
      setInvalid({ email: true, password: true })
      setPassword('')
      // the submit button was disabled while busy: put focus back where the user retries
      requestAnimationFrame(() => passwordRef.current?.focus())
    } finally {
      setBusy(false)
    }
  }

  const continueAs = async (accountId: string) => {
    if (busy) return
    setBusy(true)
    setErrorKey(null)
    try {
      finish(await session.continueAs(accountId))
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout>
      <form className="auth-card" onSubmit={(e) => void submit(e)} noValidate>
        <span className="eyebrow">{t('auth.welcome')}</span>
        <h1>{t('auth.title')}</h1>
        <p>{t('auth.mmlabsSubtitle')}</p>
        {signOutFailed && (
          <p className="auth-error" role="alert">
            {t('auth.signOutFailed')}
          </p>
        )}
        {(accountDeleted || deleteUncertain) && (
          <p className="auth-note" tabIndex={-1} ref={(el) => el?.focus()}>
            {t(deleteUncertain ? 'auth.accountDeleteUncertain' : 'auth.accountDeleted')}
          </p>
        )}
        {accounts.length > 0 && (
          <div className="auth-accounts" role="group" aria-label={t('auth.accounts.label')}>
            {accounts.map((a) => (
              <Button key={a.accountId} type="button" className="full" disabled={busy} onClick={() => void continueAs(a.accountId)}>
                {t('auth.accounts.continueAs', { email: a.email })}
              </Button>
            ))}
            <small>{t('auth.accounts.or')}</small>
          </div>
        )}
        <label>
          {t('auth.register.email')}
          <input
            ref={emailRef}
            name="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('auth.emailPlaceholder')}
            aria-invalid={errorKey !== null && invalid.email}
            aria-describedby={errorKey ? errorId : undefined}
            maxLength={320}
            autoFocus={accounts.length === 0 && !accountDeleted && !deleteUncertain}
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
        {challenge && <Turnstile siteKey={siteKey} onToken={setTurnstile} resetKey={round} />}
        {errorKey && (
          <p key={attempt} id={errorId} className="auth-error" role="alert">
            {t(errorKey)}
          </p>
        )}
        <Button type="submit" variant="primary" className="full" disabled={busy} aria-busy={busy}>
          {busy ? t('auth.submitting') : t('auth.submit')}
        </Button>
        <small>
          {t('auth.newHere')} <Link to="/register">{t('auth.createAccount')}</Link>
        </small>
      </form>
    </AuthLayout>
  )
}

/** The account is signed in at mmlabs but cannot use ricotdin yet: join (consent) or verify. */
function PendingAction({ state, onDone }: { state: Extract<AuthState, { status: 'actionRequired' }>; onDone: () => void }) {
  const { t } = useTranslation()
  const { session } = useAuth()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ key: string; ok: boolean } | null>(null)

  const run = async (work: () => Promise<unknown>, okKey?: string) => {
    if (busy) return
    setBusy(true)
    setNote(null)
    try {
      const result = await work()
      if (okKey) setNote({ key: okKey, ok: true })
      if ((result as AuthState | undefined)?.status === 'signedIn') onDone()
    } catch (err) {
      setNote({ key: signInErrorKey(err), ok: false })
    } finally {
      setBusy(false)
    }
  }
  const other = () => void session.signOut()
  const stillUnverified = async () => {
    await session.refresh()
    const now = session.getState()
    if (now.status === 'actionRequired' && now.action === 'verify') throw new ApiError(403, 'email_unverified', '')
    return now
  }
  const who = state.email || t('auth.pending.thisAccount')

  const titleKey = state.action === 'verify' ? 'auth.pending.verifyTitle' : 'auth.pending.joinTitle'
  const bodyKey = { join: 'auth.pending.joinBody', joinClosed: 'auth.pending.joinClosed', verify: 'auth.pending.verifyBody' }[state.action]
  return (
    <AuthLayout>
      <div className="auth-card">
        <h1 tabIndex={-1} ref={(el) => el?.focus()}>
          {t(titleKey)}
        </h1>
        <p>{t(bodyKey, { email: who })}</p>
        {state.action === 'join' && (
          <Button variant="primary" className="full" disabled={busy} aria-busy={busy} onClick={() => void run(() => session.join())}>
            {t('auth.accounts.continueAs', { email: who })}
          </Button>
        )}
        {state.action === 'verify' && (
          <>
            <Button variant="primary" className="full" disabled={busy} aria-busy={busy} onClick={() => void run(() => session.resendVerification(), 'auth.pending.resent')}>
              {t('auth.verify.resend')}
            </Button>
            <Button className="full" disabled={busy} onClick={() => void run(stillUnverified)}>
              {t('auth.pending.verified')}
            </Button>
          </>
        )}
        {note && (
          <p className={note.ok ? 'auth-success' : 'auth-error'} role={note.ok ? 'status' : 'alert'}>
            {t(note.key)}
          </p>
        )}
        <Button className="full" variant="ghost" disabled={busy} onClick={other}>
          {t('auth.pending.other')}
        </Button>
      </div>
    </AuthLayout>
  )
}
