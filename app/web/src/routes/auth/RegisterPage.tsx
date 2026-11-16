// Sign up for an mmlabs account (AUT-05): POST api.mmlabs.online/api/v1/auth/signup with a
// Turnstile token, then "check your inbox". The ricotdin user (and its username) is created on the
// first sign-in; the username can be changed in the profile.
import { useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useAuth, useTurnstileSiteKey } from '../../auth/AuthProvider'
import { publicAuthErrorKey } from '../../auth/authErrors'
import { normalizeEmail, validateEmail, validatePassword } from '../../auth/validate'
import { AuthLayout } from '../../components/AuthLayout'
import { Turnstile } from '../../components/Turnstile'
import { Button } from '../../components/ui/Button'
import { useDocumentTitle } from '../../lib/useDocumentTitle'

type Field = 'email' | 'password' | 'confirm'

export function RegisterPage() {
  const { t } = useTranslation()
  useDocumentTitle('auth.register.title')
  const { session } = useAuth()
  const siteKey = useTurnstileSiteKey()
  const ids = { email: useId(), password: useId(), confirm: useId(), form: useId() }
  const [values, setValues] = useState<Record<Field, string>>({ email: '', password: '', confirm: '' })
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [turnstile, setTurnstile] = useState<string | null>(null)
  const [round, setRound] = useState(0)

  const set = (f: Field) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [f]: e.target.value }))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const email = normalizeEmail(values.email)
    const next: Partial<Record<Field, string>> = {}
    const ve = validateEmail(email)
    const vp = validatePassword(values.password)
    if (ve) next.email = ve
    if (vp) next.password = vp
    if (!vp && values.confirm !== values.password) next.confirm = 'auth.validation.mismatch'
    setErrors(next)
    setFormError(null)
    const first = (['email', 'password', 'confirm'] as Field[]).find((f) => next[f])
    if (first) {
      document.getElementById(ids[first])?.focus()
      return
    }
    if (!turnstile) {
      setFormError('auth.errors.turnstile_required')
      return
    }
    setBusy(true)
    try {
      await session.publicAuth('/signup', { email, password: values.password, turnstile_token: turnstile })
      setSent(true)
    } catch (err) {
      setFormError(publicAuthErrorKey(err, 'register'))
      setRound((n) => n + 1) // the Turnstile token was used
      // the submit button was disabled while busy: continue from the first field
      requestAnimationFrame(() => document.getElementById(ids.email)?.focus())
    } finally {
      setBusy(false)
    }
  }

  if (sent) {
    return (
      <AuthLayout>
        <div className="auth-card" role="status">
          <h1 tabIndex={-1} ref={(el) => el?.focus()}>
            {t('auth.register.checkInbox')}
          </h1>
          <p>{t('auth.register.sent', { email: normalizeEmail(values.email) })}</p>
          <Link className="button button-primary full" to="/sign-in">
            {t('auth.backToSignIn')}
          </Link>
        </div>
      </AuthLayout>
    )
  }

  // help and error text sit outside the <label>, so they describe the input but are not its name
  const field = (f: Field, label: string, type: string, autoComplete: string, help?: string) => {
    const described = [help ? `${ids[f]}-help` : '', errors[f] ? `${ids[f]}-err` : ''].filter(Boolean).join(' ')
    return (
      <div className="field" key={f}>
        <label htmlFor={ids[f]}>{label}</label>
        <input
          id={ids[f]}
          type={type}
          autoComplete={autoComplete}
          value={values[f]}
          onChange={set(f)}
          aria-invalid={errors[f] ? true : undefined}
          aria-describedby={described || undefined}
          maxLength={f === 'email' ? 320 : 1024}
        />
        {help && (
          <small id={`${ids[f]}-help`} className="field-help">
            {help}
          </small>
        )}
        {errors[f] && (
          <small id={`${ids[f]}-err`} className="field-error">
            {t(errors[f])}
          </small>
        )}
      </div>
    )
  }

  return (
    <AuthLayout>
      <form className="auth-card" onSubmit={(e) => void submit(e)} noValidate aria-describedby={formError ? ids.form : undefined}>
        <span className="eyebrow">{t('auth.register.eyebrow')}</span>
        <h1>{t('auth.register.title')}</h1>
        <p>{t('auth.register.mmlabsSubtitle')}</p>
        {field('email', t('auth.register.email'), 'email', 'email')}
        {field('password', t('auth.password'), 'password', 'new-password', t('auth.register.passwordHelp'))}
        {field('confirm', t('auth.register.confirm'), 'password', 'new-password')}
        <Turnstile siteKey={siteKey} onToken={setTurnstile} resetKey={round} />
        {formError && (
          <p id={ids.form} className="auth-error" role="alert">
            {t(formError)}
          </p>
        )}
        <Button type="submit" variant="primary" className="full" disabled={busy} aria-busy={busy}>
          {busy ? t('auth.register.submitting') : t('auth.register.submit')}
        </Button>
        <small>
          {t('auth.register.haveAccount')} <Link to="/sign-in">{t('auth.submit')}</Link>
        </small>
      </form>
    </AuthLayout>
  )
}
