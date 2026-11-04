// Sign up (AUT-01, ARC-13a): POST /auth/register, then "check your inbox".
import { useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../auth/AuthProvider'
import { publicAuthErrorKey } from '../../auth/authErrors'
import { normalizeEmail, normalizeUsername, validateEmail, validatePassword, validateUsername } from '../../auth/validate'
import { AuthLayout } from '../../components/AuthLayout'
import { Button } from '../../components/ui/Button'
import { useDocumentTitle } from '../../lib/useDocumentTitle'

type Field = 'email' | 'username' | 'password' | 'confirm'

export function RegisterPage() {
  const { t } = useTranslation()
  useDocumentTitle('auth.register.title')
  const { session } = useAuth()
  const ids = { email: useId(), username: useId(), password: useId(), confirm: useId(), form: useId() }
  const [values, setValues] = useState<Record<Field, string>>({ email: '', username: '', password: '', confirm: '' })
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<{ emailSent: boolean } | null>(null)

  const set = (f: Field) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [f]: e.target.value }))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const email = normalizeEmail(values.email)
    const username = normalizeUsername(values.username)
    const next: Partial<Record<Field, string>> = {}
    const ve = validateEmail(email)
    const vu = validateUsername(username)
    const vp = validatePassword(values.password)
    if (ve) next.email = ve
    if (vu) next.username = vu
    if (vp) next.password = vp
    if (!vp && values.confirm !== values.password) next.confirm = 'auth.validation.mismatch'
    setErrors(next)
    setFormError(null)
    const first = (['email', 'username', 'password', 'confirm'] as Field[]).find((f) => next[f])
    if (first) {
      document.getElementById(ids[first])?.focus()
      return
    }
    setBusy(true)
    try {
      const res = (await session.publicAuth('/register', { email, username, password: values.password })) as { email_sent?: unknown }
      setSent({ emailSent: res?.email_sent === true })
    } catch (err) {
      setFormError(publicAuthErrorKey(err, 'register'))
    } finally {
      setBusy(false)
    }
  }

  if (sent) {
    return (
      <AuthLayout>
        <div className="auth-card" role="status">
          <h1>{t('auth.register.checkInbox')}</h1>
          <p>{sent.emailSent ? t('auth.register.sent', { email: normalizeEmail(values.email) }) : t('auth.register.notSent')}</p>
          <Link className="button button-primary full" to="/sign-in">
            {t('auth.backToSignIn')}
          </Link>
        </div>
      </AuthLayout>
    )
  }

  const field = (f: Field, label: string, type: string, autoComplete: string, help?: string) => (
    <label key={f}>
      {label}
      <input
        id={ids[f]}
        type={type}
        autoComplete={autoComplete}
        value={values[f]}
        onChange={set(f)}
        aria-invalid={errors[f] ? true : undefined}
        aria-describedby={errors[f] ? `${ids[f]}-err` : help ? `${ids[f]}-help` : undefined}
        maxLength={f === 'email' ? 320 : f === 'username' ? 100 : 1024}
      />
      {help && !errors[f] && (
        <small id={`${ids[f]}-help`} className="field-help">
          {help}
        </small>
      )}
      {errors[f] && (
        <small id={`${ids[f]}-err`} className="field-error">
          {t(errors[f])}
        </small>
      )}
    </label>
  )

  return (
    <AuthLayout>
      <form className="auth-card" onSubmit={(e) => void submit(e)} noValidate aria-describedby={formError ? ids.form : undefined}>
        <span className="eyebrow">{t('auth.register.eyebrow')}</span>
        <h1>{t('auth.register.title')}</h1>
        <p>{t('auth.register.subtitle')}</p>
        {field('email', t('auth.register.email'), 'email', 'email')}
        {field('username', t('auth.register.username'), 'text', 'username', t('auth.register.usernameHelp'))}
        {field('password', t('auth.password'), 'password', 'new-password', t('auth.register.passwordHelp'))}
        {field('confirm', t('auth.register.confirm'), 'password', 'new-password')}
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
